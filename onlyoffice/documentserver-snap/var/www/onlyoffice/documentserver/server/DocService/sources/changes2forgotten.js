/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */

'use strict';
var config = require('config');
var configCoAuthoring = config.get('services.CoAuthoring');
var co = require('co');
var pubsubService = require('./pubsubRabbitMQ');
var commonDefines = require('./../../Common/sources/commondefines');
var constants = require('./../../Common/sources/constants');
var utils = require('./../../Common/sources/utils');
const storage = require('./../../Common/sources/storage-base');
const queueService = require('./../../Common/sources/taskqueueRabbitMQ');
const operationContext = require('./../../Common/sources/operationContext');
const sqlBase = require('./baseConnector');
const docsCoServer = require('./DocsCoServer');
const taskResult = require('./taskresult');
const editorDataStorage = require('./' + config.get('services.CoAuthoring.server.editorDataStorage'));

const cfgForgottenFiles = config.get('services.CoAuthoring.server.forgottenfiles');
const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');
const cfgTableChanges = config.get('services.CoAuthoring.sql.tableChanges');

var cfgRedisPrefix = configCoAuthoring.get('redis.prefix');
var redisKeyShutdown = cfgRedisPrefix + constants.REDIS_KEY_SHUTDOWN;

var WAIT_TIMEOUT = 30000;
var LOOP_TIMEOUT = 1000;
var EXEC_TIMEOUT = WAIT_TIMEOUT + utils.getConvertionTimeout(undefined);

let addSqlParam = sqlBase.baseConnector.addSqlParameter;
function getDocumentsWithChanges(ctx) {
  return new Promise(function(resolve, reject) {
    let sqlCommand = `SELECT * FROM ${cfgTableResult} WHERE EXISTS(SELECT id FROM ${cfgTableChanges} WHERE tenant=${cfgTableResult}.tenant AND id = ${cfgTableResult}.id LIMIT 1);`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined);
  });
}
function updateDoc(ctx, docId, status, callback) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let p1 = addSqlParam(status, values);
    let p2 = addSqlParam(callback, values);
    let p3 = addSqlParam(ctx.tenant, values);
    let p4 = addSqlParam(docId, values);
    let sqlCommand = `UPDATE ${cfgTableResult} SET status=${p1},callback=${p2} WHERE tenant=${p3} AND id=${p4};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}

function shutdown() {
  return co(function*() {
    var res = true;
    let ctx = new operationContext.Context();
    try {
      let editorData = new editorDataStorage();
      ctx.logger.debug('shutdown start:' + EXEC_TIMEOUT);
      let queue = new queueService();
      yield queue.initPromise(true, false, false, false, false, false);

      let pubsub = new pubsubService();
      yield pubsub.initPromise();
      ctx.logger.debug('shutdown pubsub shutdown message');
      yield pubsub.publish(JSON.stringify({type: commonDefines.c_oPublishType.shutdown, ctx: ctx, status: true}));
      ctx.logger.debug('shutdown start wait pubsub deliver');
      yield utils.sleep(LOOP_TIMEOUT);

      let documentsWithChanges = yield getDocumentsWithChanges(ctx);
      ctx.logger.debug('shutdown docs with changes count = %s', documentsWithChanges.length);
      let docsWithEmptyForgotten = [];
      let docsWithOutOfDateForgotten = [];
      for (let i = 0; i < documentsWithChanges.length; ++i) {
        let tenant = documentsWithChanges[i].tenant;
        let docId = documentsWithChanges[i].id;
        ctx.setTenant(tenant);
        let forgotten = yield storage.listObjects(ctx, docId, cfgForgottenFiles);
        if (forgotten.length > 0) {
          let selectRes = yield taskResult.select(ctx, docId);
          if (selectRes.length > 0) {
            let row = selectRes[0];
            if (commonDefines.FileStatus.SaveVersion !== row.status && commonDefines.FileStatus.UpdateVersion !== row.status){
              docsWithOutOfDateForgotten.push([tenant, docId]);
            }
          }
        } else {
          docsWithEmptyForgotten.push([tenant, docId]);
        }
      }
      ctx.initDefault();
      ctx.logger.debug('shutdown docs with changes and empty forgotten count = %s', docsWithEmptyForgotten.length);
      ctx.logger.debug('shutdown docs with changes and out of date forgotten count = %s', docsWithOutOfDateForgotten.length);
      let docsToConvert = docsWithEmptyForgotten.concat(docsWithOutOfDateForgotten);
      for (let i = 0; i < docsToConvert.length; ++i) {
        let tenant = docsToConvert[i][0];
        let docId = docsToConvert[i][1];
        ctx.setTenant(tenant);
        yield ctx.initTenantCache();

        yield updateDoc(ctx, docId, commonDefines.FileStatus.Ok, "");
        yield editorData.addShutdown(redisKeyShutdown, docId);
        ctx.logger.debug('shutdown createSaveTimerPromise %s', docId);
        yield docsCoServer.createSaveTimer(ctx, docId, null, null, queue, true);
      }
      ctx.initDefault();
      yield utils.sleep(LOOP_TIMEOUT);

      let startTime = new Date().getTime();
      while (true) {
        let remainingFiles = yield editorData.getShutdownCount(redisKeyShutdown);
        ctx.logger.debug('shutdown remaining files:%d', remainingFiles);
        let curTime = new Date().getTime() - startTime;
        if (curTime >= EXEC_TIMEOUT || remainingFiles <= 0) {
          if(curTime >= EXEC_TIMEOUT) {
            ctx.logger.debug('shutdown timeout');
          }
          break;
        }
        yield utils.sleep(LOOP_TIMEOUT);
      }
      let countInForgotten = 0;
      for (let i = 0; i < docsToConvert.length; ++i) {
        let tenant = docsToConvert[i][0];
        let docId = docsToConvert[i][1];
        ctx.setTenant(tenant);
        let forgotten = yield storage.listObjects(ctx, docId, cfgForgottenFiles);
        if (forgotten.length > 0) {
          countInForgotten++;
        } else {
          ctx.logger.warn('shutdown missing in forgotten:%s', docId);
        }
      }
      ctx.initDefault();
      ctx.logger.debug('shutdown docs placed in forgotten:%d', countInForgotten);
      ctx.logger.debug('shutdown docs with unknown status:%d', docsToConvert.length - countInForgotten);
      yield editorData.cleanupShutdown(redisKeyShutdown);
      yield pubsub.close();
      yield queue.close();

      ctx.logger.debug('shutdown end');
    } catch (e) {
      res = false;
      ctx.logger.error('shutdown error:\r\n%s', e.stack);
    }
    process.exit(0);
    return res;
  });
};
exports.shutdown = shutdown;
shutdown();
