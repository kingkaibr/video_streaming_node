# Video Streaming API

A Node.js backend API for video streaming with HLS (HTTP Live Streaming) support and Cloudflare R2 integration.

## Architecture

This is a **backend-only** API service that provides:

- **Video Upload & Processing**: Upload videos and convert them to HLS format
- **HLS Streaming**: Serve adaptive bitrate video streams
- **Cloud Storage**: Integration with Cloudflare R2 for scalable storage
- **Range Requests**: Support for HTTP range requests (RFC 7233)

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Video Processing**: FFmpeg
- **Storage**: Cloudflare R2 (S3-compatible)
- **Streaming**: HLS (HTTP Live Streaming)
- **Logging**: Winston

## Project Structure

```
src/
├── routes/           # API endpoints
│   ├── videoRoutes.js    # Video upload/management
│   ├── hlsRoutes.js      # HLS streaming endpoints
│   ├── uploadRoutes.js   # File upload handling
│   └── r2Routes.js       # R2 storage operations
├── services/         # Business logic
│   ├── videoStreamService.js  # Video processing
│   ├── hlsService.js         # HLS generation
│   └── r2StreamService.js    # R2 integration
└── utils/
    └── logger.js     # Logging utility
```

## API Endpoints

### Video Management
- `POST /api/videos/upload` - Upload video file
- `GET /api/videos/:id` - Get video metadata
- `GET /api/videos/:id/stream` - Stream video with range support

### HLS Streaming
- `GET /api/hls/:videoId/master.m3u8` - Master playlist
- `GET /api/hls/:videoId/:quality/playlist.m3u8` - Quality-specific playlist
- `GET /api/hls/:videoId/:quality/:segment.ts` - Video segments

### R2 Storage
- `GET /api/r2/:key` - Get file from R2
- `POST /api/r2/upload` - Upload file to R2
- `DELETE /api/r2/:key` - Delete file from R2

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

3. **Required environment variables**:
   ```
   PORT=3000
   R2_ACCOUNT_ID=your_account_id
   R2_ACCESS_KEY_ID=your_access_key
   R2_SECRET_ACCESS_KEY=your_secret_key
   R2_BUCKET_NAME=your_bucket_name
   ```

4. **Install FFmpeg** (required for video processing):
   ```bash
   # macOS
   brew install ffmpeg
   
   # Ubuntu/Debian
   sudo apt update && sudo apt install ffmpeg
   ```

5. **Start the server**:
   ```bash
   npm start
   ```

## Features

### Video Processing
- Automatic HLS conversion with multiple quality levels
- Support for various input formats (MP4, AVI, MOV, etc.)
- Adaptive bitrate streaming

### Storage Integration
- Cloudflare R2 for scalable object storage
- Automatic file management and cleanup
- Cost-effective storage solution

### Streaming Optimization
- HTTP range request support for efficient streaming
- Proper CORS headers for cross-origin requests
- Optimized for CDN delivery

## Usage Example

```bash
# Upload a video
curl -X POST -F "video=@sample.mp4" http://localhost:3000/api/videos/upload

# Get HLS master playlist
curl http://localhost:3000/api/hls/video-id/master.m3u8

# Stream video with range support
curl -H "Range: bytes=0-1023" http://localhost:3000/api/videos/video-id/stream
```

## Development

```bash
# Development mode with auto-reload
npm run dev

# Check logs
tail -f logs/combined.log
```

## License

MIT