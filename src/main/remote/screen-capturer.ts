/**
 * Screen Capturer - Captures screen using Electron desktopCapturer
 * Provides MediaStream for WebRTC transmission
 */

import { desktopCapturer, screen } from 'electron';
import { EventEmitter } from 'events';
import {
  RemoteQuality,
  QualitySettings,
  QUALITY_PRESETS,
} from '../../shared/types';

export interface ScreenCapturerOptions {
  quality?: RemoteQuality;
  sourceId?: string; // Specific screen/window to capture
}

export class ScreenCapturer extends EventEmitter {
  private stream: MediaStream | null = null;
  private quality: RemoteQuality;
  private sourceId: string | null = null;
  private isCapturing = false;

  constructor(options: ScreenCapturerOptions = {}) {
    super();
    this.quality = options.quality || RemoteQuality.MEDIUM;
    this.sourceId = options.sourceId || null;
  }

  /**
   * Get available screen sources
   */
  async getSources(): Promise<Electron.DesktopCapturerSource[]> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
      });
      console.log(`[ScreenCapturer] Found ${sources.length} sources`);
      return sources;
    } catch (error) {
      console.error('[ScreenCapturer] Failed to get sources:', error);
      throw error;
    }
  }

  /**
   * Get primary screen source
   */
  async getPrimarySource(): Promise<Electron.DesktopCapturerSource | null> {
    const sources = await this.getSources();
    // Find the entire screen (not a window)
    const screenSource = sources.find(
      (source) => source.id.startsWith('screen:') || source.name === 'Entire Screen'
    );
    return screenSource || sources[0] || null;
  }

  /**
   * Start screen capture and return MediaStream
   */
  async startCapture(sourceId?: string): Promise<MediaStream> {
    if (this.isCapturing && this.stream) {
      console.log('[ScreenCapturer] Already capturing, returning existing stream');
      return this.stream;
    }

    try {
      // Get source to capture
      const targetSourceId = sourceId || this.sourceId;
      let source: Electron.DesktopCapturerSource | null = null;

      if (targetSourceId) {
        const sources = await this.getSources();
        source = sources.find((s) => s.id === targetSourceId) || null;
      }

      if (!source) {
        source = await this.getPrimarySource();
      }

      if (!source) {
        throw new Error('No screen source available');
      }

      console.log(`[ScreenCapturer] Capturing source: ${source.name} (${source.id})`);
      this.sourceId = source.id;

      // Get quality settings
      const settings = this.getQualitySettings();
      console.log(`[ScreenCapturer] Quality: ${this.quality}`, settings);

      // Get screen dimensions for aspect ratio
      const primaryDisplay = screen.getPrimaryDisplay();
      const { width: screenWidth, height: screenHeight } = primaryDisplay.size;
      const aspectRatio = screenWidth / screenHeight;

      // Calculate dimensions maintaining aspect ratio
      let targetWidth = settings.width;
      let targetHeight = Math.round(targetWidth / aspectRatio);

      // Ensure height doesn't exceed settings
      if (targetHeight > settings.height) {
        targetHeight = settings.height;
        targetWidth = Math.round(targetHeight * aspectRatio);
      }

      // Create media stream using getUserMedia with chromeMediaSource
      // This is the Electron way to capture screens
      const stream = await (navigator.mediaDevices as any).getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            minWidth: targetWidth,
            maxWidth: targetWidth,
            minHeight: targetHeight,
            maxHeight: targetHeight,
            minFrameRate: settings.frameRate,
            maxFrameRate: settings.frameRate,
          },
        },
      });

      this.stream = stream;
      this.isCapturing = true;

      // Handle track ended
      stream.getVideoTracks().forEach((track: MediaStreamTrack) => {
        track.onended = () => {
          console.log('[ScreenCapturer] Track ended');
          this.stopCapture();
          this.emit('ended');
        };
      });

      console.log('[ScreenCapturer] Capture started successfully');
      this.emit('started', stream);

      return stream;
    } catch (error) {
      console.error('[ScreenCapturer] Failed to start capture:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop screen capture
   */
  stopCapture(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => {
        track.stop();
      });
      this.stream = null;
    }
    this.isCapturing = false;
    console.log('[ScreenCapturer] Capture stopped');
    this.emit('stopped');
  }

  /**
   * Set capture quality
   */
  setQuality(quality: RemoteQuality): void {
    this.quality = quality;
    console.log(`[ScreenCapturer] Quality set to: ${quality}`);
    this.emit('qualityChanged', quality);
  }

  /**
   * Get current quality settings
   */
  getQualitySettings(): QualitySettings {
    return QUALITY_PRESETS[this.quality];
  }

  /**
   * Get current stream
   */
  getStream(): MediaStream | null {
    return this.stream;
  }

  /**
   * Check if currently capturing
   */
  isActive(): boolean {
    return this.isCapturing && this.stream !== null;
  }

  /**
   * Get current source ID
   */
  getSourceId(): string | null {
    return this.sourceId;
  }

  /**
   * Get screen dimensions
   */
  getScreenDimensions(): { width: number; height: number } {
    const primaryDisplay = screen.getPrimaryDisplay();
    return primaryDisplay.size;
  }

  /**
   * Take a single screenshot and return as PNG buffer
   * Used by Telegram commands
   */
  async takeScreenshot(): Promise<Buffer> {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });

      if (sources.length === 0) {
        throw new Error('No screen source available');
      }

      // Get the primary screen source
      const screenSource = sources.find(
        (source) => source.id.startsWith('screen:') || source.name === 'Entire Screen'
      ) || sources[0];

      // Return the thumbnail as PNG buffer
      return screenSource.thumbnail.toPNG();
    } catch (error) {
      console.error('[ScreenCapturer] Failed to take screenshot:', error);
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.stopCapture();
    this.removeAllListeners();
    console.log('[ScreenCapturer] Destroyed');
  }
}
