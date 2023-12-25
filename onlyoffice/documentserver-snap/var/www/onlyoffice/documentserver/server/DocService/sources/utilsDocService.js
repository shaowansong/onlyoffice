/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */

'use strict';

const exifParser = require("exif-parser");
const Jimp = require("jimp");

async function fixImageExifRotation(ctx, buffer) {
  try {
    let parser = exifParser.create(buffer);
    let exif = parser.parse();
    if (exif.tags?.Orientation > 1) {
      ctx.logger.debug('fixImageExifRotation remove exif and rotate:%j', exif);
      let image = await Jimp.read(buffer);
      image.bitmap.exifBuffer = undefined;
      image.quality(90);
      image.deflateLevel(7);
      buffer = await image.getBufferAsync(Jimp.AUTO);
    }
  } catch (e) {
    ctx.logger.debug('fixImageExifRotation error:%s', e.stack);
  }
  return buffer;
}

module.exports = {
  fixImageExifRotation
};