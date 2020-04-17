/**
 * @author Stephan Hesse <disparat@gmail.com> | <tchakabam@gmail.com>
 *
 * DRM support for Hls.js
 */

import EventHandler from '../event-handler';
import Event from '../events';
import { ErrorTypes, ErrorDetails } from '../errors';

import { logger } from '../utils/logger';
import { EMEControllerConfig } from '../config';
import { KeySystems, MediaKeyFunc } from '../utils/mediakeys-helper';

import MP4Demuxer from '../demux/mp4demuxer';
import Hex from '../utils/hex';

const MAX_LICENSE_REQUEST_FAILURES = 3;

/**
 * @see https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemConfiguration
 * @param {Array<string>} audioCodecs List of required audio codecs to support
 * @param {Array<string>} videoCodecs List of required video codecs to support
 * @param {object} drmSystemOptions Optional parameters/requirements for the key-system
 * @returns {Array<MediaSystemConfiguration>} An array of supported configurations
 */

const createMediaKeySystemConfigurations = function (initDataTypes: string[], audioCodecs: string[], videoCodecs: string[]): MediaKeySystemConfiguration[] { /* jshint ignore:line */
  const baseConfig: MediaKeySystemConfiguration = {
    initDataTypes,
    // label: "",
    // persistentState: "not-allowed", // or "required" ?
    // distinctiveIdentifier: "not-allowed", // or "required" ?
    // sessionTypes: ['temporary'],
    videoCapabilities: [] // { contentType: 'video/mp4; codecs="avc1.42E01E"' }
  };

  videoCodecs.forEach((codec) => {
    baseConfig.videoCapabilities!.push({
      contentType: `video/mp4; codecs="${codec}"`
    });
  });

  return [
    baseConfig
  ];
};

/**
 * The idea here is to handle key-system (and their respective platforms) specific configuration differences
 * in order to work with the local requestMediaKeySystemAccess method.
 *
 * We can also rule-out platform-related key-system support at this point by throwing an error.
 *
 * @param {string} keySystem Identifier for the key-system, see `KeySystems` enum
 * @param {Array<string>} audioCodecs List of required audio codecs to support
 * @param {Array<string>} videoCodecs List of required video codecs to support
 * @throws will throw an error if a unknown key system is passed
 * @returns {Array<MediaSystemConfiguration>} A non-empty Array of MediaKeySystemConfiguration objects
 */
const getSupportedMediaKeySystemConfigurations = function (keySystem: KeySystems, audioCodecs: string[], videoCodecs: string[]): MediaKeySystemConfiguration[] {
  switch (keySystem) {
  case KeySystems.WIDEVINE:
    return createMediaKeySystemConfigurations([], audioCodecs, videoCodecs);
  case KeySystems.FAIRPLAY:
    return createMediaKeySystemConfigurations(['sinf'], audioCodecs, videoCodecs);
  default:
    throw new Error(`Unknown key-system: ${keySystem}`);
  }
};

interface MediaKeysListItem {
  mediaKeys?: MediaKeys,
  mediaKeysSession?: MediaKeySession,
  mediaKeysSessionInitialized: boolean;
  mediaKeySystemAccess: MediaKeySystemAccess;
  mediaKeySystemDomain: KeySystems;
  mediaKeyId?: string,
}

interface LicenseXHRAdditionalData {
  keyId?: string,
}

/**
 * Controller to deal with encrypted media extensions (EME)
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Encrypted_Media_Extensions_API
 *
 * @class
 * @constructor
 */
class EMEController extends EventHandler {
  private _widevineLicenseUrl?: string;
  private _fairplayLicenseUrl?: string;
  private _fairplayCertificateUrl?: string;
  private _fairplayCertificateData?: BufferSource;
  private _licenseXhrSetup?: (xhr: XMLHttpRequest, url: string, additionalData: LicenseXHRAdditionalData) => void;
  private _emeEnabled: boolean;
  private _requestMediaKeySystemAccess: MediaKeyFunc | null;

  private _config: EMEControllerConfig;
  private _mediaKeysList: MediaKeysListItem[] = [];
  private _media: HTMLMediaElement | null = null;
  private _levels: any[] = [];
  private _hasSetMediaKeys: boolean = false;
  private _requestLicenseFailureCount: number = 0;

  private mediaKeysPromise: Promise<MediaKeys> | null = null;

  /**
     * @constructs
     * @param {Hls} hls Our Hls.js instance
     */
  constructor (hls) {
    super(hls,
      Event.MEDIA_ATTACHED,
      Event.MEDIA_DETACHED,
      Event.MANIFEST_PARSED,
      Event.LEVEL_LOADED
    );
    this._config = hls.config;

    this._widevineLicenseUrl = this._config.widevineLicenseUrl;
    this._fairplayLicenseUrl = this._config.fairplayLicenseUrl;
    this._fairplayCertificateData = this._config.fairplayCertificateData;
    this._fairplayCertificateUrl = this._config.fairplayCertificateUrl;
    this._licenseXhrSetup = this._config.licenseXhrSetup;
    this._emeEnabled = this._config.emeEnabled;
    this._requestMediaKeySystemAccess = this._config.requestMediaKeySystemAccessFunc;
  }

  /**
   * @param {string} keySystem Identifier for the key-system, see `KeySystems` enum
   * @returns {string} License server URL for key-system (if any configured, otherwise causes error)
   * @throws if a unsupported keysystem is passed
   */
  getLicenseServerUrl (keySystem: KeySystems): string {
    switch (keySystem) {
      case KeySystems.WIDEVINE:
        if (!this._widevineLicenseUrl) {
          break;
        }
        return this._widevineLicenseUrl;

      case KeySystems.FAIRPLAY:
        if (!this._fairplayLicenseUrl) {
          break;
        }
        return this._fairplayLicenseUrl;
      }

    throw new Error(`no license server URL configured for key-system "${keySystem}"`);
  }

  /**
     * Requests access object and adds it to our list upon success
     * @private
     * @param {string} keySystem System ID (see `KeySystems`)
     * @param {Array<string>} audioCodecs List of required audio codecs to support
     * @param {Array<string>} videoCodecs List of required video codecs to support
     * @throws When a unsupported KeySystem is passed
     */
  private _attemptKeySystemAccess (keySystem: KeySystems, audioCodecs: string[], videoCodecs: string[]) {
    // TODO: add other DRM "options"

    // This can throw, but is caught in event handler callpath
    const mediaKeySystemConfigs = getSupportedMediaKeySystemConfigurations(keySystem, audioCodecs, videoCodecs);

    logger.log('Requesting encrypted media key-system access', keySystem, mediaKeySystemConfigs);

    // expecting interface like window.navigator.requestMediaKeySystemAccess
    const keySystemAccessPromise = this.requestMediaKeySystemAccess(keySystem, mediaKeySystemConfigs);

    this.mediaKeysPromise = keySystemAccessPromise.then((mediaKeySystemAccess) =>
      this._onMediaKeySystemAccessObtained(keySystem, mediaKeySystemAccess));

    keySystemAccessPromise.catch((err) => {
      logger.error(`Failed to obtain key-system "${keySystem}" access:`, err);
    });
  }

  get requestMediaKeySystemAccess () {
    if (!this._requestMediaKeySystemAccess) {
      throw new Error('No requestMediaKeySystemAccess function configured');
    }

    return this._requestMediaKeySystemAccess;
  }

  /**
     * Handles obtaining access to a key-system
     * @private
     * @param {string} keySystem
     * @param {MediaKeySystemAccess} mediaKeySystemAccess https://developer.mozilla.org/en-US/docs/Web/API/MediaKeySystemAccess
     */
  private _onMediaKeySystemAccessObtained (keySystem: KeySystems, mediaKeySystemAccess: MediaKeySystemAccess): Promise<MediaKeys> {
    logger.log(`Access for key-system "${keySystem}" obtained`);

    const mediaKeysListItem: MediaKeysListItem = {
      mediaKeysSessionInitialized: false,
      mediaKeySystemAccess: mediaKeySystemAccess,
      mediaKeySystemDomain: keySystem
    };

    this._mediaKeysList.push(mediaKeysListItem);

    const mediaKeysPromise = Promise.resolve().then(() => mediaKeySystemAccess.createMediaKeys())
      .then((mediaKeys) => {
        mediaKeysListItem.mediaKeys = mediaKeys;

        logger.log(`Media-keys created for key-system "${keySystem}"`);

        if (keySystem === KeySystems.FAIRPLAY) {
          if (this._fairplayCertificateData) {
            mediaKeys.setServerCertificate(this._fairplayCertificateData);
          } else if (this._fairplayCertificateUrl) {
            return this._fetchCertificate(this._fairplayCertificateUrl).then(certificateData => {
              mediaKeys.setServerCertificate(certificateData);
            }).catch(() => {
              this.hls.trigger(Event.ERROR, {
                type: ErrorTypes.KEY_SYSTEM_ERROR,
                details: ErrorDetails.KEY_SYSTEM_CERTIFICATE_REQUEST_FAILED,
                fatal: true
              });
            }).then(() => mediaKeys);
          }
        }

        return mediaKeys;
      }).then((mediaKeys) => {
        this._onMediaKeysCreated();

        return mediaKeys;
      });

    mediaKeysPromise.catch((err) => {
      logger.error('Failed to create media-keys:', err);
    });

    return mediaKeysPromise;
  }

  /**
   * Handles key-creation (represents access to CDM). We are going to create key-sessions upon this
   * for all existing keys where no session exists yet.
   *
   * @private
   */
  private _onMediaKeysCreated () {
    // check for all key-list items if a session exists, otherwise, create one
    this._mediaKeysList.forEach((mediaKeysListItem) => {
      if (!mediaKeysListItem.mediaKeysSession) {
        // mediaKeys is definitely initialized here
        mediaKeysListItem.mediaKeysSession = mediaKeysListItem.mediaKeys!.createSession();
        this._onNewMediaKeySession(mediaKeysListItem.mediaKeysSession);
      }
    });
  }

  /**
     * @private
     * @param {*} keySession
     */
  private _onNewMediaKeySession (keySession: MediaKeySession) {
    logger.log(`New key-system session ${keySession.sessionId}`);

    keySession.addEventListener('message', (event: MediaKeyMessageEvent) => {
      this._onKeySessionMessage(keySession, event.message);
    }, false);
  }

  /**
   * @private
   * @param {MediaKeySession} keySession
   * @param {ArrayBuffer} message
   */
  private _onKeySessionMessage (keySession: MediaKeySession, message: ArrayBuffer) {
    logger.log('Got EME message event, creating license request');

    this._requestLicense(message, (data: ArrayBuffer) => {
      logger.log(`Received license data (length: ${data ? data.byteLength : data}), updating key-session`);
      keySession.update(data);
    });
  }

  /**
   * @private
   * @param e {MediaEncryptedEvent}
   */
  private _onMediaEncrypted = (e: MediaEncryptedEvent) => {
    logger.log(`Media is encrypted using "${e.initDataType}" init data type`);

    if (!this.mediaKeysPromise) {
      logger.error('Fatal: Media is encrypted but no CDM access or no keys have been requested');
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_KEYS,
        fatal: true
      });
      return;
    }

    const finallySetKeyAndStartSession = (mediaKeys) => {
      if (!this._media) {
        return;
      }
      this._attemptSetMediaKeys(mediaKeys);
      this._generateRequestWithPreferredKeySession(e.initDataType, e.initData);
    };

    // Could use `Promise.finally` but some Promise polyfills are missing it
    this.mediaKeysPromise.then(finallySetKeyAndStartSession).catch(finallySetKeyAndStartSession);
  }

  /**
   * @private
   */
  private _attemptSetMediaKeys (mediaKeys?: MediaKeys) {
    if (!this._media) {
      throw new Error('Attempted to set mediaKeys without first attaching a media element');
    }

    if (!this._hasSetMediaKeys) {
      // FIXME: see if we can/want/need-to really to deal with several potential key-sessions?
      const keysListItem = this._mediaKeysList[0];
      if (!keysListItem || !keysListItem.mediaKeys) {
        logger.error('Fatal: Media is encrypted but no CDM access or no keys have been obtained yet');
        this.hls.trigger(Event.ERROR, {
          type: ErrorTypes.KEY_SYSTEM_ERROR,
          details: ErrorDetails.KEY_SYSTEM_NO_KEYS,
          fatal: true
        });
        return;
      }

      logger.log('Setting keys for encrypted media');

      this._media.setMediaKeys(keysListItem.mediaKeys);
      this._hasSetMediaKeys = true;
    }
  }

  private _findKeyInSinf (initData: ArrayBuffer) : string | undefined {
    const {
      // sinfData is base64 encoded
      sinf: [sinfData]
    } = JSON.parse(String.fromCharCode.apply(null, new Uint8Array(initData)));

    // Got base64 encoded data from the JSON
    const decodedSinfData = atob(sinfData);

    // Got binary data from the decoding, we need to put it back into a binary array to do operations on it
    const decodedSinfDataUint8View = new Uint8Array(decodedSinfData.length);

    for (let i = 0; i < decodedSinfData.length; i++) {
      decodedSinfDataUint8View[i] = decodedSinfData.charCodeAt(i);
    }

    // Get the "schi" box that contains the "tenc" box, that holds the keyId (still binary data)
    const [tenc] = MP4Demuxer.findBox(decodedSinfDataUint8View, ['schi', 'tenc']);

    if (!tenc) {
      return;
    }

    const { start, data } = tenc;

    /**
     * tenc is a Uint8Array, meaning one item stores one byte
     * tenc is made of
     *  - 8 bytes IV
     *  - 16 bytes keyId
     */
    return Hex.hexDump(data.subarray(start + 8, start + 24));
  }

  /**
   * @private
   */
  private _generateRequestWithPreferredKeySession (initDataType: string, initData: ArrayBuffer | null) {
    // FIXME: see if we can/want/need-to really to deal with several potential key-sessions?
    const keysListItem = this._mediaKeysList[0];
    if (!keysListItem) {
      logger.error('Fatal: Media is encrypted but not any key-system access has been obtained yet');
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_ACCESS,
        fatal: true
      });
      return;
    }

    if (keysListItem.mediaKeysSessionInitialized) {
      logger.warn('Key-Session already initialized but requested again');
      return;
    }

    const keySession = keysListItem.mediaKeysSession;
    if (!keySession) {
      logger.error('Fatal: Media is encrypted but no key-session existing');
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_SESSION,
        fatal: true
      });
      return;
    }

    // initData is null if the media is not CORS-same-origin
    if (!initData) {
      logger.warn('Fatal: initData required for generating a key session is null');
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_INIT_DATA,
        fatal: true
      });
      return;
    }

    logger.log(`Generating key-session request for "${initDataType}" init data type`);
    keysListItem.mediaKeysSessionInitialized = true;

    if (initDataType === 'sinf') {
        keysListItem.mediaKeyId = this._findKeyInSinf(initData);
    }

    keySession.generateRequest(initDataType, initData)
      .then(() => {
        logger.debug('Key-session generation succeeded');
      })
      .catch((err) => {
        logger.error('Error generating key-session request:', err);
        this.hls.trigger(Event.ERROR, {
          type: ErrorTypes.KEY_SYSTEM_ERROR,
          details: ErrorDetails.KEY_SYSTEM_NO_SESSION,
          fatal: false
        });
      });
  }

  private _fetchCertificate (url: string) : Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.open('GET', url, true);
      xhr.responseType = 'arraybuffer';

      xhr.onreadystatechange = () => {
        switch (xhr.readyState) {
          case XMLHttpRequest.DONE:
            if (xhr.status === 200) {
              resolve(xhr.response);
            } else {
              reject(new Error(xhr.responseText));
            }
            break;
        }
      };

      xhr.send();
    });
  }

  /**
   * @private
   * @param {string} url License server URL
   * @param {ArrayBuffer} keyMessage Message data issued by key-system
   * @param {function} callback Called when XHR has succeeded
   * @returns {XMLHttpRequest} Unsent (but opened state) XHR object
   * @throws if XMLHttpRequest construction failed
   */
  private _createLicenseXhr (keysListItem: MediaKeysListItem, keyMessage: ArrayBuffer, callback: (data: ArrayBuffer) => void): XMLHttpRequest {
    const url = this.getLicenseServerUrl(keysListItem.mediaKeySystemDomain);

    const xhr = new XMLHttpRequest();
    const licenseXhrSetup = this._licenseXhrSetup;
    const xhrSetupData : LicenseXHRAdditionalData = { keyId: keysListItem.mediaKeyId };

    try {
      if (licenseXhrSetup) {
        try {
          licenseXhrSetup(xhr, url, xhrSetupData);
        } catch (e) {
          // let's try to open before running setup
          xhr.open('POST', url, true);
          licenseXhrSetup(xhr, url, xhrSetupData);
        }
      }
      // if licenseXhrSetup did not yet call open, let's do it now
      if (!xhr.readyState) {
        xhr.open('POST', url, true);
      }
    } catch (e) {
      // IE11 throws an exception on xhr.open if attempting to access an HTTP resource over HTTPS
      throw new Error(`issue setting up KeySystem license XHR ${e}`);
    }

    // Because we set responseType to ArrayBuffer here, callback is typed as handling only array buffers
    xhr.responseType = 'arraybuffer';
    xhr.onreadystatechange =
        this._onLicenseRequestReadyStageChange.bind(this, xhr, url, keyMessage, callback);
    return xhr;
  }

  /**
   * @private
   * @param {XMLHttpRequest} xhr
   * @param {string} url License server URL
   * @param {ArrayBuffer} keyMessage Message data issued by key-system
   * @param {function} callback Called when XHR has succeeded
   */
  private _onLicenseRequestReadyStageChange (xhr: XMLHttpRequest, url: string, keyMessage: ArrayBuffer, callback: (data: ArrayBuffer) => void) {
    switch (xhr.readyState) {
    case 4:
      if (xhr.status === 200) {
        this._requestLicenseFailureCount = 0;
        logger.log('License request succeeded');

        if (xhr.responseType !== 'arraybuffer') {
          logger.warn('xhr response type was not set to the expected arraybuffer for license request');
        }
        callback(xhr.response);
      } else {
        logger.error(`License Request XHR failed (${url}). Status: ${xhr.status} (${xhr.statusText})`);
        this._requestLicenseFailureCount++;
        if (this._requestLicenseFailureCount > MAX_LICENSE_REQUEST_FAILURES) {
          this.hls.trigger(Event.ERROR, {
            type: ErrorTypes.KEY_SYSTEM_ERROR,
            details: ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED,
            fatal: true
          });
          return;
        }

        const attemptsLeft = MAX_LICENSE_REQUEST_FAILURES - this._requestLicenseFailureCount + 1;
        logger.warn(`Retrying license request, ${attemptsLeft} attempts left`);
        this._requestLicense(keyMessage, callback);
      }
      break;
    }
  }

  /**
   * @private
   * @param {MediaKeysListItem} keysListItem
   * @param {ArrayBuffer} keyMessage
   * @returns {ArrayBuffer} Challenge data posted to license server
   * @throws if KeySystem is unsupported
   */
  private _generateLicenseRequestChallenge (keysListItem: MediaKeysListItem, keyMessage: ArrayBuffer): ArrayBuffer {
    switch (keysListItem.mediaKeySystemDomain) {
    // case KeySystems.PLAYREADY:
    // from https://github.com/MicrosoftEdge/Demos/blob/master/eme/scripts/demo.js
    /*
      if (this.licenseType !== this.LICENSE_TYPE_WIDEVINE) {
        // For PlayReady CDMs, we need to dig the Challenge out of the XML.
        var keyMessageXml = new DOMParser().parseFromString(String.fromCharCode.apply(null, new Uint16Array(keyMessage)), 'application/xml');
        if (keyMessageXml.getElementsByTagName('Challenge')[0]) {
            challenge = atob(keyMessageXml.getElementsByTagName('Challenge')[0].childNodes[0].nodeValue);
        } else {
            throw 'Cannot find <Challenge> in key message';
        }
        var headerNames = keyMessageXml.getElementsByTagName('name');
        var headerValues = keyMessageXml.getElementsByTagName('value');
        if (headerNames.length !== headerValues.length) {
            throw 'Mismatched header <name>/<value> pair in key message';
        }
        for (var i = 0; i < headerNames.length; i++) {
            xhr.setRequestHeader(headerNames[i].childNodes[0].nodeValue, headerValues[i].childNodes[0].nodeValue);
        }
      }
      break;
    */
    case KeySystems.WIDEVINE:
    case KeySystems.FAIRPLAY:
      // For Widevine CDMs, the challenge is the keyMessage.
      return keyMessage;
    }

    throw new Error(`unsupported key-system: ${keysListItem.mediaKeySystemDomain}`);
  }

  /**
   * @private
   * @param keyMessage
   * @param callback
   */
  private _requestLicense (keyMessage: ArrayBuffer, callback: (data: ArrayBuffer) => void) {
    logger.log('Requesting content license for key-system');

    const keysListItem = this._mediaKeysList[0];
    if (!keysListItem) {
      logger.error('Fatal error: Media is encrypted but no key-system access has been obtained yet');
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_NO_ACCESS,
        fatal: true
      });
      return;
    }

    try {
      const url = this.getLicenseServerUrl(keysListItem.mediaKeySystemDomain);
      const xhr = this._createLicenseXhr(keysListItem, keyMessage, callback);
      logger.log(`Sending license request to URL: ${url}`);
      const challenge = this._generateLicenseRequestChallenge(keysListItem, keyMessage);
      xhr.send(challenge);
    } catch (e) {
      logger.error(`Failure requesting DRM license: ${e}`);
      this.hls.trigger(Event.ERROR, {
        type: ErrorTypes.KEY_SYSTEM_ERROR,
        details: ErrorDetails.KEY_SYSTEM_LICENSE_REQUEST_FAILED,
        fatal: true
      });
    }
  }

  onMediaAttached (data: { media: HTMLMediaElement; }) {
    if (!this._emeEnabled) {
      return;
    }

    const media = data.media;

    // keep reference of media
    this._media = media;

    media.addEventListener('encrypted', this._onMediaEncrypted);
  }

  onMediaDetached () {
    if (this._media) {
      this._media.removeEventListener('encrypted', this._onMediaEncrypted);
      this._media = null; // release reference
    }
  }

  onManifestParsed (data: any) {
    this._levels = data.levels;
  }

  // TODO: Use manifest types here when they are defined
  onLevelLoaded ({ details, level: index }: any) {
    const level = this._levels[index];

    if (!this._emeEnabled || !details.key || !level) {
      return;
    }

    let keySystem = KeySystems.WIDEVINE;

    if (details.key.format === 'com.apple.streamingkeydelivery') {
      keySystem = KeySystems.FAIRPLAY;
    }

    this._attemptKeySystemAccess(keySystem, [level.audioCodec], [level.videoCodec]);
  }
}

export default EMEController;
