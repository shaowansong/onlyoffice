/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';
const crypto = require('crypto');
var multiparty = require('multiparty');
var co = require('co');
var jwt = require('jsonwebtoken');
var taskResult = require('./taskresult');
const utilsDocService = require('./utilsDocService');
var docsCoServer = require('./DocsCoServer');
var utils = require('./../../Common/sources/utils');
var constants = require('./../../Common/sources/constants');
var storageBase = require('./../../Common/sources/storage-base');
var formatChecker = require('./../../Common/sources/formatchecker');
const commonDefines = require('./../../Common/sources/commondefines');
const operationContext = require('./../../Common/sources/operationContext');
var config = require('config');

const cfgImageSize = config.get('services.CoAuthoring.server.limits_image_size');
const cfgTypesUpload = config.get('services.CoAuthoring.utils.limits_image_types_upload');
const cfgTokenEnableBrowser = config.get('services.CoAuthoring.token.enable.browser');

const PATTERN_ENCRYPTED = 'ENCRYPTED;';

exports.uploadTempFile = function(req, res) {
  return co(function* () {
    var docId = 'uploadTempFile';
    let ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      ctx.logger.info('uploadTempFile start');
      let params;
      let authRes = yield docsCoServer.getRequestParams(ctx, req, true);
      if(authRes.code === constants.NO_ERROR){
        params = authRes.params;
      } else {
        utils.fillResponse(req, res, new commonDefines.ConvertStatus(authRes.code), false);
        return;
      }
      docId = params.key;
      ctx.setDocId(docId);
      ctx.logger.debug('Start uploadTempFile');
      if (docId && constants.DOC_ID_REGEX.test(docId) && req.body && Buffer.isBuffer(req.body)) {
        var task = yield* taskResult.addRandomKeyTask(ctx, docId);
        var strPath = task.key + '/' + docId + '.tmp';
        yield storageBase.putObject(ctx, strPath, req.body, req.body.length);
        var url = yield storageBase.getSignedUrl(ctx, utils.getBaseUrlByRequest(ctx, req), strPath,
                                                 commonDefines.c_oAscUrlTypes.Temporary);
        utils.fillResponse(req, res, new commonDefines.ConvertStatus(constants.NO_ERROR, url), false);
      } else {
        if (!constants.DOC_ID_REGEX.test(docId)) {
          ctx.logger.warn('Error uploadTempFile unexpected key');
        }
        utils.fillResponse(req, res, new commonDefines.ConvertStatus(constants.UNKNOWN), false);
      }
    } catch (e) {
      ctx.logger.error('Error uploadTempFile: %s', e.stack);
      utils.fillResponse(req, res, new commonDefines.ConvertStatus(constants.UNKNOWN), false);
    } finally {
      ctx.logger.info('uploadTempFile end');
    }
  });
};
function* checkJwtUpload(ctx, errorName, token){
  let checkJwtRes = yield docsCoServer.checkJwt(ctx, token, commonDefines.c_oAscSecretType.Session);
  return checkJwtUploadTransformRes(ctx, errorName, checkJwtRes);
}
function checkJwtUploadTransformRes(ctx, errorName, checkJwtRes){
  var res = {err: true, docId: null, userid: null, encrypted: null};
  if (checkJwtRes.decoded) {
    var doc = checkJwtRes.decoded.document;
    var edit = checkJwtRes.decoded.editorConfig;
    if (!edit.ds_isCloseCoAuthoring) {
      res.err = false;
      res.docId = doc.key;
      res.encrypted = doc.ds_encrypted;
      if (edit.user) {
        res.userid = edit.user.id;
      }
    } else {
      ctx.logger.warn('Error %s jwt: %s', errorName, 'access deny');
    }
  } else {
    ctx.logger.warn('Error %s jwt: %s', errorName, checkJwtRes.description);
  }
  return res;
}
exports.uploadImageFileOld = function(req, res) {
  return co(function* () {
    let ctx = new operationContext.Context();
    ctx.initFromRequest(req);
    yield ctx.initTenantCache();
    var docId = req.params.docid;
    ctx.setDocId(docId);
    ctx.logger.debug('Start uploadImageFileOld');
    const tenImageSize = ctx.getCfg('services.CoAuthoring.server.limits_image_size', cfgImageSize);
    const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

    if (tenTokenEnableBrowser) {
      var checkJwtRes = yield* checkJwtUpload(ctx, 'uploadImageFileOld', req.query['token']);
      if(!checkJwtRes.err){
        docId = checkJwtRes.docId || docId;
        ctx.setDocId(docId);
        ctx.setUserId(checkJwtRes.userid);
      } else {
        res.sendStatus(403);
        return;
      }
    }
    var listImages = [];
    if (docId) {
      var isError = false;
      var form = new multiparty.Form();
      form.on('error', function(err) {
        ctx.logger.error('Error parsing form:%s', err.toString());
        res.sendStatus(400);
      });
      form.on('part', function(part) {
        if (!part.filename) {
          part.resume();
        }
        if (part.filename) {
          if (part.byteCount > tenImageSize) {
            isError = true;
          }
          if (isError) {
            part.resume();
          } else {
            var strImageName = crypto.randomBytes(16).toString("hex");
            var strPath = docId + '/media/' + strImageName + '.jpg';
            listImages.push(strPath);
            utils.stream2Buffer(part).then(function(buffer) {
              return storageBase.putObject(ctx, strPath, buffer, buffer.length);
            }).then(function() {
              part.resume();
            }).catch(function(err) {
              ctx.logger.error('Upload putObject:%s', err.stack);
              isError = true;
              part.resume();
            });
          }
        }
        part.on('error', function(err) {
          ctx.logger.error('Error parsing form part:%s', err.toString());
        });
      });
      form.once('close', function() {
        if (isError) {
          res.sendStatus(400);
        } else {
          storageBase.getSignedUrlsByArray(ctx, utils.getBaseUrlByRequest(ctx, req), listImages, docId,
                                           commonDefines.c_oAscUrlTypes.Session).then(function(urls) {
                                                                                        var outputData = {'type': 0, 'error': constants.NO_ERROR, 'urls': urls, 'input': req.query};
                                                                                        var output = '<html><head><script type="text/javascript">function load(){ parent.postMessage("';
                                                                                        output += JSON.stringify(outputData).replace(/"/g, '\\"');
                                                                                        output += '", "*"); }</script></head><body onload="load()"></body></html>';
                                                                                        res.setHeader('Content-Type', 'text/html');
                                                                                        res.send(output);
                                                                                        ctx.logger.debug('End uploadImageFileOld:%s', output);
                                                                                      }
          ).catch(function(err) {
            ctx.logger.error('error getSignedUrlsByArray:%s', err.stack);
            res.sendStatus(400);
          });
        }
      });
      form.parse(req);
    } else {
      ctx.logger.debug('Error params uploadImageFileOld');
      res.sendStatus(400);
    }
  });
};
exports.uploadImageFile = function(req, res) {
  return co(function* () {
    let httpStatus = 200;
    var docId = 'null';
    let output = {};
    let ctx = new operationContext.Context();
    try {
      ctx.initFromRequest(req);
      yield ctx.initTenantCache();
      docId = req.params.docid;
      ctx.setDocId(docId);
      let encrypted = false;
      ctx.logger.debug('Start uploadImageFile');
      const tenImageSize = ctx.getCfg('services.CoAuthoring.server.limits_image_size', cfgImageSize);
      const tenTypesUpload = ctx.getCfg('services.CoAuthoring.utils.limits_image_types_upload', cfgTypesUpload);
      const tenTokenEnableBrowser = ctx.getCfg('services.CoAuthoring.token.enable.browser', cfgTokenEnableBrowser);

      if (tenTokenEnableBrowser) {
        let checkJwtRes = yield docsCoServer.checkJwtHeader(ctx, req, 'Authorization', 'Bearer ', commonDefines.c_oAscSecretType.Session);
        if (!checkJwtRes) {
          checkJwtRes = yield docsCoServer.checkJwt(ctx, req.query['token'], commonDefines.c_oAscSecretType.Session);
        }
        let transformedRes = checkJwtUploadTransformRes(ctx, 'uploadImageFile', checkJwtRes);
        if (!transformedRes.err) {
          docId = transformedRes.docId || docId;
          encrypted = transformedRes.encrypted;
          ctx.setDocId(docId);
          ctx.setUserId(transformedRes.userid);
        } else {
          httpStatus = 403;
        }
      }

      if (200 === httpStatus && docId && req.body && Buffer.isBuffer(req.body)) {
        let buffer = req.body;
        if (buffer.length <= tenImageSize) {
          var format = formatChecker.getImageFormat(ctx, buffer);
          var formatStr = formatChecker.getStringFromFormat(format);
          if (encrypted && PATTERN_ENCRYPTED === buffer.toString('utf8', 0, PATTERN_ENCRYPTED.length)) {
            formatStr = buffer.toString('utf8', PATTERN_ENCRYPTED.length, buffer.indexOf(';', PATTERN_ENCRYPTED.length));
          }
          var supportedFormats = tenTypesUpload || 'jpg';
          let formatLimit = formatStr && -1 !== supportedFormats.indexOf(formatStr);
          if (formatLimit) {
            var strImageName = crypto.randomBytes(16).toString("hex");
            var strPathRel = 'media/' + strImageName + '.' + formatStr;
            var strPath = docId + '/' + strPathRel;

            buffer = yield utilsDocService.fixImageExifRotation(ctx, buffer);

            yield storageBase.putObject(ctx, strPath, buffer, buffer.length);
            output[strPathRel] = yield storageBase.getSignedUrl(ctx, utils.getBaseUrlByRequest(ctx, req), strPath,
                                                                commonDefines.c_oAscUrlTypes.Session);
          } else {
            httpStatus = 415;
            ctx.logger.debug('uploadImageFile format is not supported');
          }
        } else {
          httpStatus = 413;
          ctx.logger.debug('uploadImageFile size limit exceeded: buffer.length = %d', buffer.length);
        }
      }
    } catch (e) {
      httpStatus = 400;
      ctx.logger.error('Error uploadImageFile:%s', e.stack);
    } finally {
      try {
        if (200 === httpStatus) {
          res.setHeader('Content-Type', 'application/json');
          res.send(JSON.stringify(output));
        } else {
          res.sendStatus(httpStatus);
        }
        ctx.logger.debug('End uploadImageFile: httpStatus = %d', httpStatus);
      } catch (e) {
        ctx.logger.error('Error uploadImageFile:%s', e.stack);
      }
    }
  });
};
