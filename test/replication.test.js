var async = require('async');
var loopback = require('../');
var ACL = loopback.ACL;
var Change = loopback.Change;
var defineModelTestsWithDataSource = require('./util/model-tests');
var PersistedModel = loopback.PersistedModel;
var expect = require('chai').expect;

describe('Replication / Change APIs', function() {
  var dataSource, SourceModel, TargetModel;
  var tid = 0; // per-test unique id used e.g. to build unique model names

  beforeEach(function() {
    tid++;
    var test = this;
    dataSource = this.dataSource = loopback.createDataSource({
      connector: loopback.Memory
    });
    SourceModel = this.SourceModel = PersistedModel.extend(
      'SourceModel-' + tid,
      { id: { id: true, type: String, defaultFn: 'guid' } },
      { trackChanges: true });

    SourceModel.attachTo(dataSource);

    TargetModel = this.TargetModel = PersistedModel.extend(
      'TargetModel-' + tid,
      { id: { id: true, type: String, defaultFn: 'guid' } },
      { trackChanges: true });

    // NOTE(bajtos) At the moment, all models share the same Checkpoint
    // model. This causes the in-process replication to work differently
    // than client-server replication.
    // As a workaround, we manually setup unique Checkpoint for TargetModel.
    var TargetChange = TargetModel.Change;
    TargetChange.Checkpoint = loopback.Checkpoint.extend('TargetCheckpoint');
    TargetChange.Checkpoint.attachTo(dataSource);

    TargetModel.attachTo(dataSource);

    test.startingCheckpoint = -1;

    this.createInitalData = function(cb) {
      SourceModel.create({name: 'foo'}, function(err, inst) {
        if (err) return cb(err);
        test.model = inst;

        // give loopback a chance to register the change
        // TODO(ritch) get rid of this...
        setTimeout(function() {
          SourceModel.replicate(TargetModel, cb);
        }, 100);
      });
    };
  });

  describe('Model.changes(since, filter, callback)', function() {
    it('Get changes since the given checkpoint', function(done) {
      var test = this;
      this.SourceModel.create({name: 'foo'}, function(err) {
        if (err) return done(err);
        setTimeout(function() {
          test.SourceModel.changes(test.startingCheckpoint, {}, function(err, changes) {
            assert.equal(changes.length, 1);
            done();
          });
        }, 1);
      });
    });

    it('excludes changes from older checkpoints', function(done) {
      var FUTURE_CHECKPOINT = 999;

      SourceModel.create({ name: 'foo' }, function(err) {
        if (err) return done(err);
        SourceModel.changes(FUTURE_CHECKPOINT, {}, function(err, changes) {
          if (err) return done(err);
          expect(changes).to.be.empty();
          done();
        });
      });
    });
  });

  describe('Model.replicate(since, targetModel, options, callback)', function() {
    it('Replicate data using the target model', function(done) {
      var test = this;
      var options = {};
      var sourceData;
      var targetData;

      this.SourceModel.create({name: 'foo'}, function(err) {
        setTimeout(replicate, 100);
      });

      function replicate() {
        test.SourceModel.replicate(test.startingCheckpoint, test.TargetModel,
        options, function(err, conflicts) {
          assert(conflicts.length === 0);
          async.parallel([
            function(cb) {
              test.SourceModel.find(function(err, result) {
                if (err) return cb(err);
                sourceData = result;
                cb();
              });
            },
            function(cb) {
              test.TargetModel.find(function(err, result) {
                if (err) return cb(err);
                targetData = result;
                cb();
              });
            }
          ], function(err) {
            if (err) return done(err);

            assert.deepEqual(sourceData, targetData);
            done();
          });
        });
      }
    });

    it('applies "since" filter on source changes', function(done) {
      async.series([
        function createModelInSourceCp1(next) {
          SourceModel.create({ id: '1' }, next);
        },
        function checkpoint(next) {
          SourceModel.checkpoint(next);
        },
        function createModelInSourceCp2(next) {
          SourceModel.create({ id: '2' }, next);
        },
        function replicateLastChangeOnly(next) {
          SourceModel.currentCheckpoint(function(err, cp) {
            if (err) return done(err);
            SourceModel.replicate(cp, TargetModel, next);
          });
        },
        function verify(next) {
          TargetModel.find(function(err, list) {
            if (err) return done(err);
            // '1' should be skipped by replication
            expect(getIds(list)).to.eql(['2']);
            next();
          });
        }
      ], done);
    });

    it('applies "since" filter on target changes', function(done) {
      // Because the "since" filter is just an optimization,
      // there isn't really any observable behaviour we could
      // check to assert correct implementation.
      var diffSince = [];
      spyAndStoreSinceArg(TargetModel, 'diff', diffSince);

      SourceModel.replicate(10, TargetModel, function(err) {
        if (err) return done(err);
        expect(diffSince).to.eql([10]);
        done();
      });
    });

    it('uses different "since" value for source and target', function(done) {
      var sourceSince = [];
      var targetSince = [];

      spyAndStoreSinceArg(SourceModel, 'changes', sourceSince);
      spyAndStoreSinceArg(TargetModel, 'diff', targetSince);

      var since = { source: 1, target: 2 };
      SourceModel.replicate(since, TargetModel, function(err) {
        if (err) return done(err);
        expect(sourceSince).to.eql([1]);
        expect(targetSince).to.eql([2]);
        done();
      });
    });

    it('pick ups changes made during replication', function(done) {
      var bulkUpdate = TargetModel.bulkUpdate;
      TargetModel.bulkUpdate = function(data, cb) {
        var self = this;
        // simulate the situation when another model is created
        // while a replication run is in progress
        SourceModel.create({ id: 'racer' }, function(err) {
          if (err) return cb(err);
          bulkUpdate.call(self, data, cb);
        });
      };

      var lastCp;
      async.series([
        function buildSomeDataToReplicate(next) {
          SourceModel.create({ id: 'init' }, next);
        },
        function getLastCp(next) {
          SourceModel.currentCheckpoint(function(err, cp) {
            if (err) return done(err);
            lastCp = cp;
            next();
          });
        },
        function replicate(next) {
          SourceModel.replicate(TargetModel, next);
        },
        function verifyAssumptions(next) {
          SourceModel.find(function(err, list) {
            expect(getIds(list), 'source ids')
              .to.eql(['init', 'racer']);

            TargetModel.find(function(err, list) {
              expect(getIds(list), 'target ids after first sync')
                .to.eql(['init']);
              next();
            });
          });
        },
        function replicateAgain(next) {
          TargetModel.bulkUpdate = bulkUpdate;
          SourceModel.replicate(lastCp + 1, TargetModel, next);
        },
        function verify(next) {
          TargetModel.find(function(err, list) {
            expect(getIds(list), 'target ids').to.eql(['init', 'racer']);
            next();
          });
        }
      ], done);
    });

    it('returns new current checkpoints to callback', function(done) {
      var sourceCp, targetCp;
      async.series([
        bumpSourceCheckpoint,
        bumpTargetCheckpoint,
        bumpTargetCheckpoint,
        function replicate(cb) {
          expect(sourceCp).to.not.equal(targetCp);

          SourceModel.replicate(
            TargetModel,
            function(err, conflicts, newCheckpoints) {
              if (err) return cb(err);
              expect(conflicts, 'conflicts').to.eql([]);
              expect(newCheckpoints, 'currentCheckpoints').to.eql({
                source: sourceCp + 1,
                target: targetCp + 1
              });
              cb();
            });
        }
      ], done);

      function bumpSourceCheckpoint(cb) {
        SourceModel.checkpoint(function(err, inst) {
          if (err) return cb(err);
          sourceCp = inst.seq;
          cb();
        });
      }

      function bumpTargetCheckpoint(cb) {
        TargetModel.checkpoint(function(err, inst) {
          if (err) return cb(err);
          targetCp = inst.seq;
          cb();
        });
      }
    });

  });

  describe('conflict detection - both updated', function() {
    beforeEach(function(done) {
      var SourceModel = this.SourceModel;
      var TargetModel = this.TargetModel;
      var test = this;

      test.createInitalData(createConflict);

      function createConflict(err, conflicts) {
        async.parallel([
          function(cb) {
            SourceModel.findOne(function(err, inst) {
              if (err) return cb(err);
              inst.name = 'source update';
              inst.save(cb);
            });
          },
          function(cb) {
            TargetModel.findOne(function(err, inst) {
              if (err) return cb(err);
              inst.name = 'target update';
              inst.save(cb);
            });
          }
        ], function(err) {
          if (err) return done(err);
          SourceModel.replicate(TargetModel, function(err, conflicts) {
            if (err) return done(err);
            test.conflicts = conflicts;
            test.conflict = conflicts[0];
            done();
          });
        });
      }
    });
    it('should detect a single conflict', function() {
      assert.equal(this.conflicts.length, 1);
      assert(this.conflict);
    });
    it('type should be UPDATE', function(done) {
      this.conflict.type(function(err, type) {
        assert.equal(type, Change.UPDATE);
        done();
      });
    });
    it('conflict.changes()', function(done) {
      var test = this;
      this.conflict.changes(function(err, sourceChange, targetChange) {
        assert.equal(typeof sourceChange.id, 'string');
        assert.equal(typeof targetChange.id, 'string');
        assert.equal(test.model.getId(), sourceChange.getModelId());
        assert.equal(sourceChange.type(), Change.UPDATE);
        assert.equal(targetChange.type(), Change.UPDATE);
        done();
      });
    });
    it('conflict.models()', function(done) {
      var test = this;
      this.conflict.models(function(err, source, target) {
        assert.deepEqual(source.toJSON(), {
          id: test.model.id,
          name: 'source update'
        });
        assert.deepEqual(target.toJSON(), {
          id: test.model.id,
          name: 'target update'
        });
        done();
      });
    });
  });

  describe('conflict detection - source deleted', function() {
    beforeEach(function(done) {
      var SourceModel = this.SourceModel;
      var TargetModel = this.TargetModel;
      var test = this;

      test.createInitalData(createConflict);

      function createConflict() {
        async.parallel([
          function(cb) {
            SourceModel.findOne(function(err, inst) {
              if (err) return cb(err);
              test.model = inst;
              inst.remove(cb);
            });
          },
          function(cb) {
            TargetModel.findOne(function(err, inst) {
              if (err) return cb(err);
              inst.name = 'target update';
              inst.save(cb);
            });
          }
        ], function(err) {
          if (err) return done(err);
          SourceModel.replicate(TargetModel, function(err, conflicts) {
            if (err) return done(err);
            test.conflicts = conflicts;
            test.conflict = conflicts[0];
            done();
          });
        });
      }
    });
    it('should detect a single conflict', function() {
      assert.equal(this.conflicts.length, 1);
      assert(this.conflict);
    });
    it('type should be DELETE', function(done) {
      this.conflict.type(function(err, type) {
        assert.equal(type, Change.DELETE);
        done();
      });
    });
    it('conflict.changes()', function(done) {
      var test = this;
      this.conflict.changes(function(err, sourceChange, targetChange) {
        assert.equal(typeof sourceChange.id, 'string');
        assert.equal(typeof targetChange.id, 'string');
        assert.equal(test.model.getId(), sourceChange.getModelId());
        assert.equal(sourceChange.type(), Change.DELETE);
        assert.equal(targetChange.type(), Change.UPDATE);
        done();
      });
    });
    it('conflict.models()', function(done) {
      var test = this;
      this.conflict.models(function(err, source, target) {
        assert.equal(source, null);
        assert.deepEqual(target.toJSON(), {
          id: test.model.id,
          name: 'target update'
        });
        done();
      });
    });
  });

  describe('conflict detection - target deleted', function() {
    beforeEach(function(done) {
      var SourceModel = this.SourceModel;
      var TargetModel = this.TargetModel;
      var test = this;

      test.createInitalData(createConflict);

      function createConflict() {
        async.parallel([
          function(cb) {
            SourceModel.findOne(function(err, inst) {
              if (err) return cb(err);
              test.model = inst;
              inst.name = 'source update';
              inst.save(cb);
            });
          },
          function(cb) {
            TargetModel.findOne(function(err, inst) {
              if (err) return cb(err);
              inst.remove(cb);
            });
          }
        ], function(err) {
          if (err) return done(err);
          SourceModel.replicate(TargetModel, function(err, conflicts) {
            if (err) return done(err);
            test.conflicts = conflicts;
            test.conflict = conflicts[0];
            done();
          });
        });
      }
    });
    it('should detect a single conflict', function() {
      assert.equal(this.conflicts.length, 1);
      assert(this.conflict);
    });
    it('type should be DELETE', function(done) {
      this.conflict.type(function(err, type) {
        assert.equal(type, Change.DELETE);
        done();
      });
    });
    it('conflict.changes()', function(done) {
      var test = this;
      this.conflict.changes(function(err, sourceChange, targetChange) {
        assert.equal(typeof sourceChange.id, 'string');
        assert.equal(typeof targetChange.id, 'string');
        assert.equal(test.model.getId(), sourceChange.getModelId());
        assert.equal(sourceChange.type(), Change.UPDATE);
        assert.equal(targetChange.type(), Change.DELETE);
        done();
      });
    });
    it('conflict.models()', function(done) {
      var test = this;
      this.conflict.models(function(err, source, target) {
        assert.equal(target, null);
        assert.deepEqual(source.toJSON(), {
          id: test.model.id,
          name: 'source update'
        });
        done();
      });
    });
  });

  describe('conflict detection - both deleted', function() {
    beforeEach(function(done) {
      var SourceModel = this.SourceModel;
      var TargetModel = this.TargetModel;
      var test = this;

      test.createInitalData(createConflict);

      function createConflict() {
        async.parallel([
          function(cb) {
            SourceModel.findOne(function(err, inst) {
              if (err) return cb(err);
              test.model = inst;
              inst.remove(cb);
            });
          },
          function(cb) {
            TargetModel.findOne(function(err, inst) {
              if (err) return cb(err);
              inst.remove(cb);
            });
          }
        ], function(err) {
          if (err) return done(err);
          SourceModel.replicate(TargetModel, function(err, conflicts) {
            if (err) return done(err);
            test.conflicts = conflicts;
            test.conflict = conflicts[0];
            done();
          });
        });
      }
    });
    it('should not detect a conflict', function() {
      assert.equal(this.conflicts.length, 0);
      assert(!this.conflict);
    });
  });

  describe('change detection', function() {
    it('detects "create"', function(done) {
      SourceModel.create({}, function(err, inst) {
        if (err) return done(err);
        assertChangeRecordedForId(inst.id, done);
      });
    });

    it('detects "updateOrCreate"', function(done) {
      givenReplicatedInstance(function(err, created) {
        if (err) return done(err);
        var data = created.toObject();
        created.name = 'updated';
        SourceModel.updateOrCreate(created, function(err, inst) {
          if (err) return done(err);
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    it('detects "findOrCreate"', function(done) {
      // make sure we bypass find+create and call the connector directly
      SourceModel.dataSource.connector.findOrCreate =
        function(model, query, data, callback) {
          this.all(model, query, function(err, list) {
            if (err || (list && list[0]))
              return callback(err, list && list[0], false);
            this.create(model, data, function(err) {
              callback(err, data, true);
            });
          }.bind(this));
        };

      SourceModel.findOrCreate(
        { where: { name: 'does-not-exist' } },
        { name: 'created' },
        function(err, inst) {
          if (err) return done(err);
          assertChangeRecordedForId(inst.id, done);
        });
    });

    it('detects "deleteById"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        SourceModel.deleteById(inst.id, function(err) {
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    it('detects "deleteAll"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        SourceModel.deleteAll({ name: inst.name }, function(err) {
          if (err) return done(err);
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    it('detects "updateAll"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        SourceModel.updateAll(
          { name: inst.name },
          { name: 'updated' },
          function(err) {
            if (err) return done(err);
            assertChangeRecordedForId(inst.id, done);
          });
      });
    });

    it('detects "prototype.save"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        inst.name = 'updated';
        inst.save(function(err) {
          if (err) return done(err);
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    it('detects "prototype.updateAttributes"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        inst.updateAttributes({ name: 'updated' }, function(err) {
          if (err) return done(err);
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    it('detects "prototype.delete"', function(done) {
      givenReplicatedInstance(function(err, inst) {
        if (err) return done(err);
        inst.delete(function(err) {
          assertChangeRecordedForId(inst.id, done);
        });
      });
    });

    function givenReplicatedInstance(cb) {
      SourceModel.create({ name: 'a-name' }, function(err, inst) {
        if (err) return cb(err);
        SourceModel.checkpoint(function(err) {
          if (err) return cb(err);
          cb(null, inst);
        });
      });
    }

    function assertChangeRecordedForId(id, cb) {
      SourceModel.getChangeModel().getCheckpointModel()
        .current(function(err, cp) {
          if (err) return cb(err);
          SourceModel.changes(cp - 1, {}, function(err, pendingChanges) {
            if (err) return cb(err);
            expect(pendingChanges, 'list of changes').to.have.length(1);
            var change = pendingChanges[0].toObject();
            expect(change).to.have.property('checkpoint', cp); // sanity check
            expect(change).to.have.property('modelName', SourceModel.modelName);
            // NOTE(bajtos) Change.modelId is always String
            // regardless of the type of the changed model's id property
            expect(change).to.have.property('modelId', '' + id);
            cb();
          });
        });
    }
  });

  function spyAndStoreSinceArg(Model, methodName, store) {
    var orig = Model[methodName];
    Model[methodName] = function(since) {
      store.push(since);
      orig.apply(this, arguments);
    };
  }

  function getPropValue(obj, name) {
    return Array.isArray(obj) ?
      obj.map(function(it) { return getPropValue(it, name); }) :
      obj[name];
  }

  function getIds(list) {
    return getPropValue(list, 'id');
  }
});
