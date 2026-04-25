import QRCode from 'qrcode';
import { Html5Qrcode } from 'html5-qrcode';

let activeScanner = null;

function getReadableQrSize(canvas) {
  const viewportWidth = Number(globalThis.innerWidth) || 360;
  const preferred = Math.min(460, Math.max(320, viewportWidth - 40));
  const declared = Number(canvas.width) || preferred;
  return Math.round(Math.min(460, Math.max(320, Math.max(preferred, declared))));
}

/**
 * Renders QR data onto a canvas by id.
 * @param {string} data - Text payload to encode.
 * @param {string} canvasId - Target canvas element id.
 * @returns {Promise<HTMLCanvasElement>} Rendered canvas.
 */
export async function renderQR(data, canvasId) {
  try {
    const canvas = document.getElementById(canvasId);

    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error(`Canvas "${canvasId}" was not found.`);
    }

    await QRCode.toCanvas(canvas, String(data ?? ''), {
      width: getReadableQrSize(canvas),
      margin: 4,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });

    return canvas;
  } catch (error) {
    throw new Error(`Unable to render QR: ${error.message}`);
  }
}

/**
 * Starts the camera QR scanner.
 * @param {string} elementId - Scanner container element id.
 * @param {(decodedText: string) => void | Promise<void>} onSuccess - Callback for decoded QR text.
 * @returns {Promise<Html5Qrcode>} Active scanner instance.
 */
export async function startScanner(elementId, onSuccess) {
  try {
    await stopScanner();

    if (typeof onSuccess !== 'function') {
      throw new Error('Scanner success callback is required.');
    }

    activeScanner = new Html5Qrcode(elementId, false);
    await activeScanner.start(
      { facingMode: 'environment' },
      {
        fps: 12,
        qrbox(viewfinderWidth, viewfinderHeight) {
          const edge = Math.min(viewfinderWidth, viewfinderHeight);
          const size = Math.floor(Math.min(380, Math.max(240, edge * 0.82)));
          return {
            width: size,
            height: size
          };
        },
        aspectRatio: 1
      },
      (decodedText) => {
        void onSuccess(decodedText);
      },
      () => {}
    );

    return activeScanner;
  } catch (error) {
    activeScanner = null;
    throw new Error(`Unable to start scanner: ${error.message}`);
  }
}

/**
 * Stops the active QR scanner.
 * @returns {Promise<boolean>} True when a scanner was stopped.
 */
export async function stopScanner() {
  try {
    if (!activeScanner) {
      return false;
    }

    await activeScanner.stop();
    activeScanner.clear();
    activeScanner = null;
    return true;
  } catch (error) {
    activeScanner = null;
    throw new Error(`Unable to stop scanner: ${error.message}`);
  }
}

/**
 * Splits a large string into numbered QR chunk payloads.
 * @param {string} dataString - Original data string.
 * @param {number} maxSize - Maximum chunk data size.
 * @returns {{c: number, t: number, d: string}[]} Chunk objects.
 */
export function generateChunks(dataString, maxSize = 1800) {
  try {
    const source = String(dataString ?? '');
    const safeMaxSize = Math.max(200, Number(maxSize) || 1800);
    const payloadSize = Math.max(100, safeMaxSize - 80);
    const total = Math.max(1, Math.ceil(source.length / payloadSize));

    return Array.from({ length: total }, (_, index) => ({
      c: index + 1,
      t: total,
      d: source.slice(index * payloadSize, (index + 1) * payloadSize)
    }));
  } catch (error) {
    throw new Error(`Unable to generate QR chunks: ${error.message}`);
  }
}
