/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';
var fs = require('fs');
var url = require('url');
var path = require('path');
const { S3Client, ListObjectsCommand, HeadObjectCommand} = require("@aws-sdk/client-s3");
const { GetObjectCommand, PutObjectCommand, CopyObjectCommand} = require("@aws-sdk/client-s3");
const { DeleteObjectsCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
var mime = require('mime');
var utils = require('./utils');
const ms = require('ms');
const commonDefines = require('./../../Common/sources/commondefines');

var config = require('config');
var configStorage = require('config').get('storage');
var cfgRegion = configStorage.get('region');
var cfgEndpoint = configStorage.get('endpoint');
var cfgBucketName = configStorage.get('bucketName');
var cfgStorageFolderName = configStorage.get('storageFolderName');
var cfgAccessKeyId = configStorage.get('accessKeyId');
var cfgSecretAccessKey = configStorage.get('secretAccessKey');
var cfgSslEnabled = configStorage.get('sslEnabled');
var cfgS3ForcePathStyle = configStorage.get('s3ForcePathStyle');
var configFs = configStorage.get('fs');
var cfgStorageUrlExpires = configFs.get('urlExpires');
const cfgExpSessionAbsolute = ms(config.get('services.CoAuthoring.expire.sessionabsolute'));
var configS3 = {
  region: cfgRegion,
  endpoint: cfgEndpoint,
  credentials : {
  accessKeyId: cfgAccessKeyId,
  secretAccessKey: cfgSecretAccessKey
  }
};

if (configS3.endpoint) {
  configS3.sslEnabled = cfgSslEnabled;
  configS3.s3ForcePathStyle = cfgS3ForcePathStyle;
}
const client  = new S3Client(configS3);
var MAX_DELETE_OBJECTS = 1000;

function getFilePath(strPath) {
  return cfgStorageFolderName + '/' + strPath;
}
function joinListObjects(inputArray, outputArray) {
  if (!inputArray) {
    return;
  }
  var length = inputArray.length;
  for (var i = 0; i < length; i++) {
    outputArray.push(inputArray[i].Key.substring((cfgStorageFolderName + '/').length));
  }
}
async function listObjectsExec(output, params) {
  const data = await client.send(new ListObjectsCommand(params));
      joinListObjects(data.Contents, output);
  if (data.IsTruncated && (data.NextMarker || (data.Contents && data.Contents.length > 0))) {
        params.Marker = data.NextMarker || data.Contents[data.Contents.length - 1].Key;
    return await listObjectsExec(output, params);
      } else {
    return output;
      }
}
async function deleteObjectsHelp(aKeys) {
  const input = {
    Bucket: cfgBucketName,
    Delete: {
      Objects: aKeys,
      Quiet: true
      }
  };
  const command = new DeleteObjectsCommand(input);
  return await client.send(command);
}

exports.headObject = async function(strPath) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath)
  };
  const command = new HeadObjectCommand(input);
  return await client.send(command);
};
exports.getObject = async function(strPath) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath)
  };
  const command = new GetObjectCommand(input);
  const output = await client.send(command);

  return await utils.stream2Buffer(output.Body);
};
exports.createReadStream = async function(strPath) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath)
          };
  const command = new GetObjectCommand(input);
  const output = await client.send(command);
  return {
    contentLength: output.ContentLength,
    readStream: output.Body
  };
};
exports.putObject = async function(strPath, buffer, contentLength) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath),
    Body: buffer,
    ContentLength: contentLength,
    ContentType: mime.getType(strPath)
  };
  const command = new PutObjectCommand(input);
  return await client.send(command);
};
exports.uploadObject = async function(strPath, filePath) {
  const file = fs.createReadStream(filePath);
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath),
    Body: file,
    ContentType: mime.getType(strPath)
  };
  const command = new PutObjectCommand(input);
  return await client.send(command);
};
exports.copyObject = function(sourceKey, destinationKey) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(destinationKey),
    CopySource: `/${cfgBucketName}/${getFilePath(sourceKey)}`
  };
  const command = new CopyObjectCommand(input);
  return client.send(command);
};
exports.listObjects = async function(strPath) {
    var params = {Bucket: cfgBucketName, Prefix: getFilePath(strPath)};
    var output = [];
  return await listObjectsExec(output, params);
};
exports.deleteObject = function(strPath) {
  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath)
  };
  const command = new DeleteObjectCommand(input);
  return client.send(command);
};
exports.deleteObjects = function(strPaths) {
  var aKeys = strPaths.map(function (currentValue) {
    return {Key: getFilePath(currentValue)};
  });
  var deletePromises = [];
  for (var i = 0; i < aKeys.length; i += MAX_DELETE_OBJECTS) {
    deletePromises.push(deleteObjectsHelp(aKeys.slice(i, i + MAX_DELETE_OBJECTS)));
  }
  return Promise.all(deletePromises);
};
exports.getSignedUrl = async function (ctx, baseUrl, strPath, urlType, optFilename, opt_creationDate) {
    var expires = (commonDefines.c_oAscUrlTypes.Session === urlType ? cfgExpSessionAbsolute / 1000 : cfgStorageUrlExpires) || 31536000;
  expires = Math.min(expires, 604800);
    var userFriendlyName = optFilename ? optFilename.replace(/\//g, "%2f") : path.basename(strPath);
    var contentDisposition = utils.getContentDisposition(userFriendlyName, null, null);

  const input = {
    Bucket: cfgBucketName,
    Key: getFilePath(strPath),
    ResponseContentDisposition: contentDisposition
  };
  const command = new GetObjectCommand(input);
  var options = {
    expiresIn: expires
    };
  return await getSignedUrl(client, command, options);
};
