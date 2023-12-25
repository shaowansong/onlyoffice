/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

const crypto = require('crypto');
var sqlBase = require('./baseConnector');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');
var commonDefines = require('./../../Common/sources/commondefines');
var tenantManager = require('./../../Common/sources/tenantManager');
var config = require('config');

const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');
const cfgTableChanges = config.get('services.CoAuthoring.sql.tableChanges');

let addSqlParam = sqlBase.baseConnector.addSqlParameter;
let concatParams = sqlBase.baseConnector.concatParams;

var RANDOM_KEY_MAX = 10000;

function TaskResultData() {
  this.tenant = null;
  this.key = null;
  this.status = null;
  this.statusInfo = null;
  this.lastOpenDate = null;
  this.creationDate = null;
  this.userIndex = null;
  this.changeId = null;
  this.callback = null;
  this.baseurl = null;
  this.password = null;
  this.additional = null;

  this.innerPasswordChange = null;//not a DB field
}
TaskResultData.prototype.completeDefaults = function() {
  if (!this.tenant) {
    this.tenant = tenantManager.getDefautTenant();
  }
  if (!this.key) {
    this.key = '';
  }
  if (!this.status) {
    this.status = commonDefines.FileStatus.None;
  }
  if (!this.statusInfo) {
    this.statusInfo = constants.NO_ERROR;
  }
  if (!this.lastOpenDate) {
    this.lastOpenDate = new Date();
  }
  if (!this.creationDate) {
    this.creationDate = new Date();
  }
  if (!this.userIndex) {
    this.userIndex = 1;
  }
  if (!this.changeId) {
    this.changeId = 0;
  }
  if (!this.callback) {
    this.callback = '';
  }
  if (!this.baseurl) {
    this.baseurl = '';
  }
};

function upsert(ctx, task, opt_updateUserIndex) {
  return sqlBase.baseConnector.upsert(ctx, task, opt_updateUserIndex);
}

function select(ctx, docId) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let p1 = addSqlParam(ctx.tenant, values);
    let p2 = addSqlParam(docId, values);
    let sqlCommand = `SELECT * FROM ${cfgTableResult} WHERE tenant=${p1} AND id=${p2};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}
function toUpdateArray(task, updateTime, isMask, values, setPassword) {
  var res = [];
  if (null != task.status) {
    let sqlParam = addSqlParam(task.status, values);
    res.push(`status=${sqlParam}`);
  }
  if (null != task.statusInfo) {
    let sqlParam = addSqlParam(task.statusInfo, values);
    res.push(`status_info=${sqlParam}` );

  }
  if (updateTime) {
    let sqlParam = addSqlParam(new Date(), values);
    res.push(`last_open_date=${sqlParam}`);

  }
  if (null != task.indexUser) {
    let sqlParam = addSqlParam(task.indexUser, values);
    res.push(`user_index=${sqlParam}`);

  }
  if (null != task.changeId) {
    let sqlParam = addSqlParam(task.changeId, values);
    res.push(`change_id=${sqlParam}`);

  }
  if (null != task.callback && !isMask) {
    var userCallback = new sqlBase.UserCallback();
    userCallback.fromValues(task.indexUser, task.callback);
    let sqlParam = addSqlParam(userCallback.toSQLInsert(), values);
    res.push(`callback=${concatParams('callback', sqlParam)}`);
  }
  if (null != task.baseurl) {
    let sqlParam = addSqlParam(task.baseurl, values);
    res.push(`baseurl=${sqlParam}`);
  }
  if (setPassword) {
    let sqlParam = addSqlParam(task.password, values);
    res.push(`password=${sqlParam}`);
  } else if (null != task.password || setPassword) {
    var documentPassword = new sqlBase.DocumentPassword();
    documentPassword.fromValues(task.password, task.innerPasswordChange);
    let sqlParam = addSqlParam(documentPassword.toSQLInsert(), values);
    res.push(`password=${concatParams('password', sqlParam)}`);
  }
  if (null != task.additional) {
    let sqlParam = addSqlParam(task.additional, values);
    res.push(`additional=${concatParams('additional', sqlParam)}`);
  }
  return res;
}

function update(ctx, task, setPassword) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let updateElems = toUpdateArray(task, true, false, values, setPassword);
    let sqlSet = updateElems.join(', ');
    let p1 = addSqlParam(task.tenant, values);
    let p2 = addSqlParam(task.key, values);
    let sqlCommand = `UPDATE ${cfgTableResult} SET ${sqlSet} WHERE tenant=${p1} AND id=${p2};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}

function updateIf(ctx, task, mask) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let commandArg = toUpdateArray(task, true, false, values, false);
    let commandArgMask = toUpdateArray(mask, false, true, values, false);
    commandArgMask.push('tenant=' + addSqlParam(mask.tenant, values));
    commandArgMask.push('id=' + addSqlParam(mask.key, values));
    let sqlSet = commandArg.join(', ');
    let sqlWhere = commandArgMask.join(' AND ');
    let sqlCommand = `UPDATE ${cfgTableResult} SET ${sqlSet} WHERE ${sqlWhere};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}
function restoreInitialPassword(ctx, docId) {
  return select(ctx, docId).then(function(selectRes) {
    if (selectRes.length > 0) {
      var row = selectRes[0];
      let docPassword = sqlBase.DocumentPassword.prototype.getDocPassword(ctx, row.password);
      var updateTask = new TaskResultData();
      updateTask.tenant = ctx.tenant;
      updateTask.key = docId;
      if (docPassword.initial) {
        var documentPassword = new sqlBase.DocumentPassword();
        documentPassword.fromValues(docPassword.initial);
        updateTask.password = documentPassword.toSQLInsert();
        return update(ctx, updateTask, true);
      } else if (docPassword.current) {
        updateTask.password = null;
        return update(ctx, updateTask, true);
      }
    }
  });
}

function addRandomKey(ctx, task, opt_prefix, opt_size) {
  return new Promise(function(resolve, reject) {
    task.tenant = ctx.tenant;
    if (undefined !== opt_prefix && undefined !== opt_size) {
      task.key = opt_prefix + crypto.randomBytes(opt_size).toString("hex");
    } else {
      task.key = task.key + '_' + Math.round(Math.random() * RANDOM_KEY_MAX);
    }
    task.completeDefaults();
    let values = [];
    let p0 = addSqlParam(task.tenant, values);
    let p1 = addSqlParam(task.key, values);
    let p2 = addSqlParam(task.status, values);
    let p3 = addSqlParam(task.statusInfo, values);
    let p4 = addSqlParam(new Date(), values);
    let p5 = addSqlParam(task.userIndex, values);
    let p6 = addSqlParam(task.changeId, values);
    let p7 = addSqlParam(task.callback, values);
    let p8 = addSqlParam(task.baseurl, values);
    let sqlCommand = `INSERT INTO ${cfgTableResult} (tenant, id, status, status_info, last_open_date, user_index, change_id, callback, baseurl)` +
      ` VALUES (${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8});`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}
function* addRandomKeyTask(ctx, key, opt_prefix, opt_size) {
  var task = new TaskResultData();
  task.tenant = ctx.tenant;
  task.key = key;
  task.status = commonDefines.FileStatus.WaitQueue;
  var nTryCount = RANDOM_KEY_MAX;
  var addRes = null;
  while (nTryCount-- > 0) {
    try {
      addRes = yield addRandomKey(ctx, task, opt_prefix, opt_size);
    } catch (e) {
      addRes = null;
    }
    if (addRes && addRes.affectedRows > 0) {
      break;
    }
  }
  if (addRes && addRes.affectedRows > 0) {
    return task;
  } else {
    throw new Error('addRandomKeyTask Error');
  }
}

function remove(ctx, docId) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let p1 = addSqlParam(ctx.tenant, values);
    let p2 = addSqlParam(docId, values);
    const sqlCommand = `DELETE FROM ${cfgTableResult} WHERE tenant=${p1} AND id=${p2};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}
function removeIf(ctx, mask) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let commandArgMask = toUpdateArray(mask, false, true, values, false);
    commandArgMask.push('tenant=' + addSqlParam(mask.tenant, values));
    commandArgMask.push('id=' + addSqlParam(mask.key, values));
    let sqlWhere = commandArgMask.join(' AND ');
    const sqlCommand = `DELETE FROM ${cfgTableResult} WHERE ${sqlWhere};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}
function getExpired(ctx, maxCount, expireSeconds) {
  return new Promise(function(resolve, reject) {
    let values = [];
    let expireDate = new Date();
    utils.addSeconds(expireDate, -expireSeconds);
    let sqlParam1 = addSqlParam(expireDate, values);
    let sqlParam2 = addSqlParam(maxCount, values);
    let sqlCommand = `SELECT * FROM ${cfgTableResult} WHERE last_open_date <= ${sqlParam1}` +
      ` AND NOT EXISTS(SELECT tenant, id FROM ${cfgTableChanges} WHERE ${cfgTableChanges}.tenant = ${cfgTableResult}.tenant AND ${cfgTableChanges}.id = ${cfgTableResult}.id LIMIT 1) LIMIT ${sqlParam2};`;
    sqlBase.baseConnector.sqlQuery(ctx, sqlCommand, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    }, undefined, undefined, values);
  });
}

exports.TaskResultData = TaskResultData;
exports.upsert = upsert;
exports.select = select;
exports.update = update;
exports.updateIf = updateIf;
exports.restoreInitialPassword = restoreInitialPassword;
exports.addRandomKeyTask = addRandomKeyTask;
exports.remove = remove;
exports.removeIf = removeIf;
exports.getExpired = getExpired;