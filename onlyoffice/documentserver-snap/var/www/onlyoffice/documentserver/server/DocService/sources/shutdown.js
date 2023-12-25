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
var logger = require('./../../Common/sources/logger');
var pubsubService = require('./pubsubRabbitMQ');
var commonDefines = require('./../../Common/sources/commondefines');
var constants = require('./../../Common/sources/constants');
var utils = require('./../../Common/sources/utils');

var cfgRedisPrefix = configCoAuthoring.get('redis.prefix');
var redisKeyShutdown = cfgRedisPrefix + constants.REDIS_KEY_SHUTDOWN;

var WAIT_TIMEOUT = 30000;
var LOOP_TIMEOUT = 1000;
var EXEC_TIMEOUT = WAIT_TIMEOUT + utils.getConvertionTimeout(undefined);

exports.shutdown = function(ctx, editorData, status) {
  return co(function*() {
    var res = true;
    try {
      ctx.logger.debug('shutdown start:' + EXEC_TIMEOUT);
      yield editorData.cleanupShutdown(redisKeyShutdown);

      var pubsub = new pubsubService();
      yield pubsub.initPromise();
      ctx.logger.debug('shutdown pubsub shutdown message');
      yield pubsub.publish(JSON.stringify({type: commonDefines.c_oPublishType.shutdown, ctx: ctx, status: status}));
      ctx.logger.debug('shutdown start wait pubsub deliver');
      var startTime = new Date().getTime();
      var isStartWait = true;
      while (true) {
        var curTime = new Date().getTime() - startTime;
        if (isStartWait && curTime >= WAIT_TIMEOUT) {
          isStartWait = false;
          ctx.logger.debug('shutdown stop wait pubsub deliver');
        } else if (curTime >= EXEC_TIMEOUT) {
          res = false;
          ctx.logger.debug('shutdown timeout');
          break;
        }
        var remainingFiles = yield editorData.getShutdownCount(redisKeyShutdown);
        ctx.logger.debug('shutdown remaining files:%d', remainingFiles);
        if (!isStartWait && remainingFiles <= 0) {
          break;
        }
        yield utils.sleep(LOOP_TIMEOUT);
      }
      yield editorData.cleanupShutdown(redisKeyShutdown);
      yield pubsub.close();

      ctx.logger.debug('shutdown end');
    } catch (e) {
      res = false;
      ctx.logger.error('shutdown error: %s', e.stack);
    }
    return res;
  });
};
