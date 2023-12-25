/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

var fs = require('fs');
const fse = require('fs-extra')
var path = require('path');
var mkdirp = require('mkdirp');
var utils = require("./utils");
var crypto = require('crypto');
const ms = require('ms');
const commonDefines = require('./../../Common/sources/commondefines');

var config = require('config');
var configStorage = config.get('storage');
var cfgBucketName = configStorage.get('bucketName');
var cfgStorageFolderName = configStorage.get('storageFolderName');
var configFs = configStorage.get('fs');
var cfgStorageFolderPath = configFs.get('folderPath');
var cfgStorageSecretString = configFs.get('secretString');
var cfgStorageUrlExpires = configFs.get('urlExpires');
const cfgExpSessionAbsolute = ms(config.get('services.CoAuthoring.expire.sessionabsolute'));

function getFilePath(strPath) {
  return path.join(cfgStorageFolderPath, strPath);
}
function getOutputPath(strPath) {
  return strPath.replace(/\\/g, '/');
}
function removeEmptyParent(strPath, done) {
  if (cfgStorageFolderPath.length + 1 >= strPath.length) {
    done();
  } else {
    fs.readdir(strPath, function(err, list) {
      if (err) {
        done();
      } else {
        if (list.length > 0) {
          done();
        } else {
          fs.rmdir(strPath, function(err) {
            if (err) {
              done();
            } else {
              removeEmptyParent(path.dirname(strPath), function(err) {
                done(err);
              });
            }
          });
        }
      }
    });
  }
}

exports.headObject = function(strPath) {
  return utils.fsStat(getFilePath(strPath)).then(function(stats) {
    return {ContentLength: stats.size};
  });
};
exports.getObject = function(strPath) {
  return utils.readFile(getFilePath(strPath));
};
exports.createReadStream = function(strPath) {
  let fsPath = getFilePath(strPath);
  let contentLength;
  return new Promise(function(resolve, reject) {
    fs.stat(fsPath, function(err, stats) {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  }).then(function(stats){
    contentLength = stats.size;
    return utils.promiseCreateReadStream(fsPath);
  }).then(function(readStream, stats){
    return {
      contentLength: contentLength,
      readStream: readStream
    };
  });
};

exports.putObject = function(strPath, buffer, contentLength) {
  return new Promise(function(resolve, reject) {
    var fsPath = getFilePath(strPath);
    mkdirp(path.dirname(fsPath), function(err) {
      if (err) {
        reject(err);
      } else {
        if (Buffer.isBuffer(buffer)) {
          fs.writeFile(fsPath, buffer, function(err) {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        } else {
          utils.promiseCreateWriteStream(fsPath).then(function(writable) {
            buffer.pipe(writable);
          }).catch(function(err) {
            reject(err);
          });
        }
      }
    });
  });
};
exports.uploadObject = function(strPath, filePath) {
  let fsPath = getFilePath(strPath);
  return fse.copy(filePath, fsPath);
};
exports.copyObject = function(sourceKey, destinationKey) {
  let fsPathSource = getFilePath(sourceKey);
  let fsPathSestination = getFilePath(destinationKey);
  return fse.copy(fsPathSource, fsPathSestination);
};
exports.listObjects = function(strPath) {
  return utils.listObjects(getFilePath(strPath)).then(function(values) {
    return values.map(function(curvalue) {
      return getOutputPath(curvalue.substring(cfgStorageFolderPath.length + 1));
    });
  });
};
exports.deleteObject = function(strPath) {
  return new Promise(function(resolve, reject) {
    const fsPath = getFilePath(strPath);
    fs.unlink(fsPath, function(err) {
      if (err) {
        reject(err);
      } else {
        removeEmptyParent(path.dirname(fsPath), function(err) {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }
    });
  });
};
exports.deleteObjects = function(strPaths) {
  return Promise.all(strPaths.map(exports.deleteObject));
};
exports.getSignedUrl = function(ctx, baseUrl, strPath, urlType, optFilename, opt_creationDate) {
  return new Promise(function(resolve, reject) {
    var userFriendlyName = optFilename ? encodeURIComponent(optFilename.replace(/\//g, "%2f")) : path.basename(strPath);
    var uri = '/' + cfgBucketName + '/' + cfgStorageFolderName + '/' + strPath + '/' + userFriendlyName;
    var url = utils.checkBaseUrl(ctx, baseUrl).replace(/_/g, "%5f");
    url += uri;

    var date = Date.now();
    let creationDate = opt_creationDate || date;
    let expiredAfter = (commonDefines.c_oAscUrlTypes.Session === urlType ? (cfgExpSessionAbsolute / 1000) : cfgStorageUrlExpires) || 31536000;
    var expires = creationDate + Math.ceil(Math.abs(date - creationDate)/expiredAfter) * expiredAfter;
    expires = Math.ceil(expires / 1000);
    expires += expiredAfter;

    var md5 = crypto.createHash('md5').update(expires + decodeURIComponent(uri) + cfgStorageSecretString).digest("base64");
    md5 = md5.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

    url += '?md5=' + encodeURIComponent(md5);
    url += '&expires=' + encodeURIComponent(expires);
    url += '&filename=' + userFriendlyName;
    resolve(url);
  });
};
