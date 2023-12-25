/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

var pg = require('pg');
var co = require('co');
var types = require('pg').types;
var sqlBase = require('./baseConnector');
const config = require('config');
var configSql = config.get('services.CoAuthoring.sql');
const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');
var pgPoolExtraOptions = configSql.get('pgPoolExtraOptions');
const cfgEditor = config.get('services.CoAuthoring.editor');

let connectionConfig = {
  host: configSql.get('dbHost'),
  port: configSql.get('dbPort'),
  user: configSql.get('dbUser'),
  password: configSql.get('dbPass'),
  database: configSql.get('dbName'),
  max: configSql.get('connectionlimit'),
  min: 0,
  ssl: false,
  idleTimeoutMillis: 30000
};
config.util.extendDeep(connectionConfig, pgPoolExtraOptions);
var pool = new pg.Pool(connectionConfig);
pg.defaults.parseInputDatesAsUTC = true;
types.setTypeParser(1114, function(stringValue) {
  return new Date(stringValue + '+0000');
});
types.setTypeParser(1184, function(stringValue) {
  return new Date(stringValue + '+0000');
});

var maxPacketSize = configSql.get('max_allowed_packet');

exports.sqlQuery = function(ctx, sqlCommand, callbackFunction, opt_noModifyRes, opt_noLog, opt_values) {
  co(function *() {
    var result = null;
    var error = null;
    try {
      result = yield pool.query(sqlCommand, opt_values);
    } catch (err) {
      error = err;
      if (!opt_noLog) {
        ctx.logger.warn('sqlQuery error sqlCommand: %s: %s', sqlCommand.slice(0, 50), err.stack);
      }
    } finally {
      if (callbackFunction) {
        var output = result;
        if (result && !opt_noModifyRes) {
          if ('SELECT' === result.command) {
            output = result.rows;
          } else {
            output = {affectedRows: result.rowCount};
          }
        }
        callbackFunction(error, output);
      }
    }
  });
};
let addSqlParam = function (val, values) {
  values.push(val);
  return '$' + values.length;
};
exports.addSqlParameter = addSqlParam;
let concatParams = function (val1, val2) {
  return `COALESCE(${val1}, '') || COALESCE(${val2}, '')`;
};
exports.concatParams = concatParams;
var isSupportOnConflict = true;

function getUpsertString(task, values) {
  task.completeDefaults();
  let dateNow = new Date();
  let cbInsert = task.callback;
  if (isSupportOnConflict && task.callback) {
    let userCallback = new sqlBase.UserCallback();
    userCallback.fromValues(task.userIndex, task.callback);
    cbInsert = userCallback.toSQLInsert();
  }
  let p0 = addSqlParam(task.tenant, values);
  let p1 = addSqlParam(task.key, values);
  let p2 = addSqlParam(task.status, values);
  let p3 = addSqlParam(task.statusInfo, values);
  let p4 = addSqlParam(dateNow, values);
  let p5 = addSqlParam(task.userIndex, values);
  let p6 = addSqlParam(task.changeId, values);
  let p7 = addSqlParam(cbInsert, values);
  let p8 = addSqlParam(task.baseurl, values);
  if (isSupportOnConflict) {
    let p9 = addSqlParam(dateNow, values);
    let sqlCommand = `INSERT INTO ${cfgTableResult} (tenant, id, status, status_info, last_open_date, user_index, change_id, callback, baseurl)`;
    sqlCommand += ` VALUES (${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8})`;
    sqlCommand += ` ON CONFLICT (tenant, id) DO UPDATE SET last_open_date = ${p9}`;
    if (task.callback) {
      let p10 = addSqlParam(JSON.stringify(task.callback), values);
      sqlCommand += `, callback = ${cfgTableResult}.callback || '${sqlBase.UserCallback.prototype.delimiter}{"userIndex":' `;
      sqlCommand += ` || (${cfgTableResult}.user_index + 1)::text || ',"callback":' || ${p10}::text || '}'`;
    }
    if (task.baseurl) {
      let p11 = addSqlParam(task.baseurl, values);
      sqlCommand += `, baseurl = ${p11}`;
    }
    sqlCommand += `, user_index = ${cfgTableResult}.user_index + 1 RETURNING user_index as userindex;`;
    return sqlCommand;
  } else {
    return `SELECT * FROM merge_db(${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8});`;
  }
}
exports.upsert = function(ctx, task) {
  return new Promise(function(resolve, reject) {
    let values = [];
    var sqlCommand = getUpsertString(task, values);
    exports.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        if (isSupportOnConflict && '42601' === error.code) {
          isSupportOnConflict = false;
          ctx.logger.warn('checkIsSupportOnConflict false');
          resolve(exports.upsert(ctx, task));
        } else {
          reject(error);
        }
      } else {
        if (result && result.rows.length > 0) {
          var first = result.rows[0];
          result = {affectedRows: 0, insertId: 0};
          result.affectedRows = task.userIndex !== first.userindex ? 2 : 1;
          result.insertId = first.userindex;
        }
        resolve(result);
      }
    }, true, undefined, values);
  });
};
exports.insertChanges = function(ctx, tableChanges, startIndex, objChanges, docId, index, user, callback) {
  let i = startIndex;
  if (i >= objChanges.length) {
    return;
  }
  let isSupported = true;
  let tenant = [];
  let id = [];
  let changeId = [];
  let userId = [];
  let userIdOriginal = [];
  let username = [];
  let change = [];
  let time = [];
  let sqlCommand = `INSERT INTO ${tableChanges} (tenant, id, change_id, user_id, user_id_original, user_name, change_data, change_date) `;
  let changesType = cfgEditor['binaryChanges'] ? 'bytea' : 'text';
  sqlCommand += `SELECT * FROM UNNEST ($1::text[], $2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::${changesType}[], $8::timestamp[]);`;
  let values = [tenant, id, changeId, userId, userIdOriginal, username, change, time];
  let curLength = sqlCommand.length;
  for (; i < objChanges.length; ++i) {
    curLength += 4 * (docId.length + user.id.length + user.idOriginal.length + user.username.length + objChanges[i].change.length) + 4 + 8;
    if (curLength >= maxPacketSize && i > startIndex) {
      exports.sqlQuery(ctx, sqlCommand, function(error, output) {
        if (error && '42883' == error.code) {
          isSupported = false;
          ctx.logger.warn('postgresql does not support UNNEST');
        }
        if (error) {
          callback(error, output, isSupported);
        } else {
          exports.insertChanges(ctx, tableChanges, i, objChanges, docId, index, user, callback);
        }
      }, undefined, undefined, values);
      return;
    }
    tenant.push(ctx.tenant);
    id.push(docId);
    changeId.push(index++);
    userId.push(user.id);
    userIdOriginal.push(user.idOriginal);
    username.push(user.username);
    change.push(objChanges[i].change);
    time.push(objChanges[i].time);
  }
  exports.sqlQuery(ctx, sqlCommand, function(error, output) {
    if (error && '42883' == error.code) {
      isSupported = false;
      ctx.logger.warn('postgresql does not support UNNEST');
    }
    callback(error, output, isSupported);
  }, undefined, undefined, values);
};
