const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const logger = require('../utils/logger');

const mkdir = promisify(fs.mkdir);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

class HLSService {
  constructor() {
    this.hlsDir = path.join(__dirname, '../../hls');
    this.ensureHLSDirectory();
    
    // Set FFmpeg paths if specified in environment
    if (process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
    }
    if (process.env.FFPROBE_PATH) {
      ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
    }
  }

  /**
   * Ensure HLS directory exists
   */
  async ensureHLSDirectory() {
    try {
      await mkdir(this.hlsDir, { recursive: true });
    } catch (error) {
      logger.error('Error creating HLS directory:', error);
    }
  }

  /**
   * Convert video to HLS format with multiple quality levels
   * @param {string} inputPath - Path to input video file
   * @param {string} outputName - Output name (without extension)
   * @param {Object} options - Conversion options
   * @returns {Promise<Object>} Conversion result
   */
  async convertToHLS(inputPath, outputName, options = {}) {
    return new Promise((resolve, reject) => {
      const outputDir = path.join(this.hlsDir, outputName);
      const playlistPath = path.join(outputDir, 'playlist.m3u8');
      
      // Create output directory
      fs.mkdirSync(outputDir, { recursive: true });

      const segmentDuration = options.segmentDuration || process.env.HLS_SEGMENT_DURATION || 10;
      const playlistSize = options.playlistSize || process.env.HLS_PLAYLIST_SIZE || 5;

      // Define quality levels for adaptive streaming
      const qualities = options.qualities || [
        { name: '720p', width: 1280, height: 720, bitrate: '2500k', audioBitrate: '128k' },
        { name: '480p', width: 854, height: 480, bitrate: '1000k', audioBitrate: '96k' },
        { name: '360p', width: 640, height: 360, bitrate: '600k', audioBitrate: '64k' }
      ];

      let completedQualities = 0;
      const totalQualities = qualities.length;
      const results = {};

      // Create master playlist
      const masterPlaylist = this.createMasterPlaylist(qualities, outputName);
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), masterPlaylist);

      // Convert each quality level
      qualities.forEach((quality) => {
        const qualityDir = path.join(outputDir, quality.name);
        fs.mkdirSync(qualityDir, { recursive: true });

        const qualityPlaylist = path.join(qualityDir, 'playlist.m3u8');
        const segmentPattern = path.join(qualityDir, 'segment_%03d.ts');

        ffmpeg(inputPath)
          .outputOptions([
            '-c:v libx264',
            '-c:a aac',
            `-b:v ${quality.bitrate}`,
            `-b:a ${quality.audioBitrate}`,
            `-s ${quality.width}x${quality.height}`,
            '-preset fast',
            '-g 48',
            '-sc_threshold 0',
            '-f hls',
            `-hls_time ${segmentDuration}`,
            `-hls_list_size 0`,
            '-hls_flags delete_segments+append_list',
            `-hls_segment_filename ${segmentPattern}`
          ])
          .output(qualityPlaylist)
          .on('start', (commandLine) => {
            logger.info(`Starting HLS conversion for ${quality.name}: ${commandLine}`);
          })
          .on('progress', (progress) => {
            logger.debug(`${quality.name} progress: ${progress.percent}%`);
          })
          .on('end', () => {
            logger.info(`HLS conversion completed for ${quality.name}`);
            
            // Add EXT-X-ENDLIST to the playlist for VOD content
            const playlistContent = fs.readFileSync(qualityPlaylist, 'utf8');
            if (!playlistContent.includes('#EXT-X-ENDLIST')) {
              fs.appendFileSync(qualityPlaylist, '#EXT-X-ENDLIST\n');
            }
            
            results[quality.name] = {
              playlist: `${outputName}/${quality.name}/playlist.m3u8`,
              directory: qualityDir
            };
            
            completedQualities++;
            if (completedQualities === totalQualities) {
              resolve({
                masterPlaylist: `${outputName}/master.m3u8`,
                qualities: results,
                outputDir: outputDir
              });
            }
          })
          .on('error', (error) => {
            logger.error(`HLS conversion error for ${quality.name}:`, error);
            reject(error);
          })
          .run();
      });
    });
  }

  /**
   * Create master playlist for adaptive streaming
   * @param {Array} qualities - Quality levels
   * @param {string} outputName - Output name
   * @returns {string} Master playlist content
   */
  createMasterPlaylist(qualities, outputName) {
    let playlist = '#EXTM3U\n#EXT-X-VERSION:3\n\n';
    
    qualities.forEach((quality) => {
      const bandwidth = parseInt(quality.bitrate.replace('k', '')) * 1000;
      playlist += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${quality.width}x${quality.height}\n`;
      playlist += `${quality.name}/playlist.m3u8\n\n`;
    });

    return playlist;
  }

  /**
   * Get HLS playlist content
   * @param {string} playlistPath - Path to playlist file
   * @returns {string} Playlist content
   */
  async getPlaylist(playlistPath) {
    try {
      const fullPath = path.join(this.hlsDir, playlistPath);
      const content = fs.readFileSync(fullPath, 'utf8');
      return content;
    } catch (error) {
      logger.error('Error reading playlist:', error);
      throw error;
    }
  }

  /**
   * Get HLS segment
   * @param {string} segmentPath - Path to segment file
   * @returns {Buffer} Segment data
   */
  async getSegment(segmentPath) {
    try {
      const fullPath = path.join(this.hlsDir, segmentPath);
      return fs.readFileSync(fullPath);
    } catch (error) {
      logger.error('Error reading segment:', error);
      throw error;
    }
  }

  /**
   * List available HLS streams
   * @returns {Array} List of available streams
   */
  async listStreams() {
    try {
      const items = await readdir(this.hlsDir);
      const streams = [];

      for (const item of items) {
        const itemPath = path.join(this.hlsDir, item);
        const stats = await stat(itemPath);
        
        if (stats.isDirectory()) {
          const masterPlaylist = path.join(itemPath, 'master.m3u8');
          const playlistExists = fs.existsSync(masterPlaylist);
          
          if (playlistExists) {
            const qualities = await this.getStreamQualities(item);
            streams.push({
              name: item,
              masterPlaylist: `${item}/master.m3u8`,
              qualities: qualities,
              createdAt: stats.birthtime,
              size: await this.getStreamSize(itemPath)
            });
          }
        }
      }

      return streams;
    } catch (error) {
      logger.error('Error listing streams:', error);
      throw error;
    }
  }

  /**
   * Get qualities available for a stream
   * @param {string} streamName - Stream name
   * @returns {Array} Available qualities
   */
  async getStreamQualities(streamName) {
    try {
      const streamDir = path.join(this.hlsDir, streamName);
      const items = await readdir(streamDir);
      
      const qualities = [];
      for (const item of items) {
        const itemPath = path.join(streamDir, item);
        const stats = await stat(itemPath);
        
        if (stats.isDirectory() && item !== 'master.m3u8') {
          const playlistPath = path.join(itemPath, 'playlist.m3u8');
          if (fs.existsSync(playlistPath)) {
            qualities.push({
              name: item,
              playlist: `${streamName}/${item}/playlist.m3u8`,
              url: `/api/hls/${streamName}/${item}/playlist.m3u8`
            });
          }
        }
      }
      
      return qualities;
    } catch (error) {
      logger.error('Error getting stream qualities:', error);
      return [];
    }
  }

  /**
   * Get total size of a stream directory
   * @param {string} streamPath - Path to stream directory
   * @returns {number} Total size in bytes
   */
  async getStreamSize(streamPath) {
    try {
      let totalSize = 0;
      const items = await readdir(streamPath, { withFileTypes: true });
      
      for (const item of items) {
        const itemPath = path.join(streamPath, item.name);
        if (item.isDirectory()) {
          totalSize += await this.getStreamSize(itemPath);
        } else {
          const stats = await stat(itemPath);
          totalSize += stats.size;
        }
      }
      
      return totalSize;
    } catch (error) {
      logger.error('Error calculating stream size:', error);
      return 0;
    }
  }

  /**
   * Delete HLS stream
   * @param {string} streamName - Stream name to delete
   */
  async deleteStream(streamName) {
    try {
      const streamPath = path.join(this.hlsDir, streamName);
      if (fs.existsSync(streamPath)) {
        fs.rmSync(streamPath, { recursive: true, force: true });
        logger.info(`Deleted HLS stream: ${streamName}`);
      }
    } catch (error) {
      logger.error('Error deleting stream:', error);
      throw error;
    }
  }

  /**
   * Check if stream exists
   * @param {string} streamName - Stream name
   * @returns {boolean} True if stream exists
   */
  streamExists(streamName) {
    const streamPath = path.join(this.hlsDir, streamName);
    const masterPlaylist = path.join(streamPath, 'master.m3u8');
    return fs.existsSync(masterPlaylist);
  }
}

module.exports = HLSService;