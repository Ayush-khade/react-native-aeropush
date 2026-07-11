//
//  Aeropush.mm
//  react-native-aeropush
//
//  Objective-C++ implementation of the AeroPush Turbo Module.
//
//  Compiled as Obj-C++ (.mm) so it can pull in the C++ Codegen spec and the
//  TurboModule registration glue. Everything is implemented with first-party
//  Apple frameworks only — NSURLSession, NSFileManager, NSUserDefaults — so
//  the SDK ships with zero third-party native dependencies.
//

#import "Aeropush.h"

#import <React/RCTLog.h>
#import <React/RCTReloadCommand.h>
#import <React/RCTUtils.h>

#import <zlib.h>

// ─── Persistent storage keys (NSUserDefaults) ──────────────────────────────
// Namespaced with "aeropush_" so we never collide with the host app.
static NSString *const kActiveBundlePathKey   = @"aeropush_active_bundle_path";
static NSString *const kPreviousBundlePathKey = @"aeropush_previous_bundle_path";
static NSString *const kLaunchFailureCountKey = @"aeropush_launch_failure_count";
static NSString *const kDidBackgroundKey      = @"aeropush_did_background";

// Consecutive failed launches before we auto-roll back. Mirrors the JS
// default documented in the SDK config.
static NSInteger const kLaunchFailureThreshold = 3;

// Info.plist key the host app sets at build time (via our build phase script)
// to embed the native fingerprint.
static NSString *const kFingerprintInfoPlistKey = @"AeroPushNativeFingerprint";

// Event name emitted for download progress. Must match the JS side.
static NSString *const kDownloadProgressEvent = @"AeropushDownloadProgress";

#pragma mark - Private interface

@interface Aeropush () <NSURLSessionDownloadDelegate>
@end

@implementation Aeropush {
  // Maps an in-flight NSURLSessionDownloadTask to the promise + destination
  // it belongs to, plus the expected total bytes for progress math.
  NSMutableDictionary<NSNumber *, RCTPromiseResolveBlock> *_downloadResolvers;
  NSMutableDictionary<NSNumber *, RCTPromiseRejectBlock>  *_downloadRejecters;
  NSMutableDictionary<NSNumber *, NSString *>             *_downloadDestinations;
}

RCT_EXPORT_MODULE(Aeropush)

- (instancetype)init {
  if (self = [super init]) {
    _downloadResolvers    = [NSMutableDictionary new];
    _downloadRejecters    = [NSMutableDictionary new];
    _downloadDestinations = [NSMutableDictionary new];
  }
  return self;
}

// TurboModules methods run on a background queue by default unless a method
// touches UIKit. We keep everything off the main thread except restart().
+ (BOOL)requiresMainQueueSetup {
  return NO;
}

#pragma mark - Storage helpers

+ (NSUserDefaults *)defaults {
  return [NSUserDefaults standardUserDefaults];
}

#pragma mark - Launcher API (native-to-native)

+ (nullable NSString *)activeBundlePath {
  NSString *path = [[self defaults] stringForKey:kActiveBundlePathKey];
  if (path.length == 0) {
    return nil;
  }
  return path;
}

+ (nullable NSURL *)bundleURL {
  NSUserDefaults *defaults = [self defaults];

  // ── Layer 1: launch counter check ────────────────────────────────────
  // If the previous N launches never reported "healthy", the active bundle
  // is presumed bad — roll back before we hand a URL to the runtime.
  NSInteger failureCount = [defaults integerForKey:kLaunchFailureCountKey];

  if (failureCount >= kLaunchFailureThreshold) {
    RCTLogWarn(@"[AeroPush] %ld consecutive failed launches — rolling back.",
               (long)failureCount);
    [self rollbackToPreviousBundle];
    [defaults setInteger:0 forKey:kLaunchFailureCountKey];
    [defaults synchronize];
    // Fall through: activeBundlePath now reflects the rolled-back target
    // (previous good bundle, or nil for the binary bundle).
  } else {
    // Optimistically count this launch as "in progress". JS clears it via
    // markBundleHealthy() once the app mounts successfully.
    [defaults setInteger:(failureCount + 1) forKey:kLaunchFailureCountKey];
    [defaults setBool:NO forKey:kDidBackgroundKey];
    [defaults synchronize];
  }

  NSString *path = [self activeBundlePath];
  if (path.length == 0) {
    return nil; // caller falls back to embedded binary bundle
  }

  // Guard against a dangling pointer to a bundle we failed to keep on disk.
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    RCTLogWarn(@"[AeroPush] active bundle missing on disk, ignoring: %@", path);
    return nil;
  }

  return [NSURL fileURLWithPath:path];
}

+ (void)rollbackToPreviousBundle {
  NSUserDefaults *defaults = [self defaults];
  NSString *previous = [defaults stringForKey:kPreviousBundlePathKey];

  if (previous.length > 0 &&
      [[NSFileManager defaultManager] fileExistsAtPath:previous]) {
    [defaults setObject:previous forKey:kActiveBundlePathKey];
  } else {
    // No known-good previous bundle — drop to the binary bundle.
    [defaults removeObjectForKey:kActiveBundlePathKey];
  }
  [defaults removeObjectForKey:kPreviousBundlePathKey];
  [defaults synchronize];
}

#pragma mark - Bundle path resolution (spec methods)

- (NSString *)getActiveBundlePath {
  NSString *path = [Aeropush activeBundlePath];
  return path ?: @"";
}

RCT_EXPORT_METHOD(setActiveBundlePath:(NSString *)path
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [Aeropush defaults];
    // Remember the currently-active bundle as the rollback target before we
    // overwrite it, so a bad new bundle can revert to this known-good one.
    NSString *current = [defaults stringForKey:kActiveBundlePathKey];
    if (current.length > 0) {
      [defaults setObject:current forKey:kPreviousBundlePathKey];
    }
    [defaults setObject:path forKey:kActiveBundlePathKey];
    // A freshly staged bundle starts unproven: reset the failure counter so
    // the next launch gets a clean set of attempts.
    [defaults setInteger:0 forKey:kLaunchFailureCountKey];
    [defaults synchronize];
    resolve(nil);
  } @catch (NSException *e) {
    reject(@"E_SET_BUNDLE", e.reason, nil);
  }
}

RCT_EXPORT_METHOD(clearActiveBundlePath:(RCTPromiseResolveBlock)resolve
                                reject:(RCTPromiseRejectBlock)reject) {
  @try {
    NSUserDefaults *defaults = [Aeropush defaults];
    NSString *current = [defaults stringForKey:kActiveBundlePathKey];
    if (current.length > 0) {
      [defaults setObject:current forKey:kPreviousBundlePathKey];
    }
    [defaults removeObjectForKey:kActiveBundlePathKey];
    [defaults setInteger:0 forKey:kLaunchFailureCountKey];
    [defaults synchronize];
    resolve(nil);
  } @catch (NSException *e) {
    reject(@"E_CLEAR_BUNDLE", e.reason, nil);
  }
}

#pragma mark - File download (NSURLSession)

RCT_EXPORT_METHOD(downloadFile:(NSString *)url
                      destPath:(NSString *)destPath
                       headers:(NSDictionary *)headers
                       resolve:(RCTPromiseResolveBlock)resolve
                        reject:(RCTPromiseRejectBlock)reject) {
  NSURL *remote = [NSURL URLWithString:url];
  if (!remote) {
    reject(@"E_BAD_URL", [NSString stringWithFormat:@"Invalid URL: %@", url], nil);
    return;
  }

  // Ensure the destination directory exists.
  NSString *destDir = [destPath stringByDeletingLastPathComponent];
  NSError *dirErr = nil;
  [[NSFileManager defaultManager] createDirectoryAtPath:destDir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:&dirErr];
  if (dirErr) {
    reject(@"E_MKDIR", dirErr.localizedDescription, dirErr);
    return;
  }

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:remote];
  [headers enumerateKeysAndObjectsUsingBlock:^(id key, id obj, BOOL *stop) {
    if ([key isKindOfClass:[NSString class]] &&
        [obj isKindOfClass:[NSString class]]) {
      [request setValue:obj forHTTPHeaderField:key];
    }
  }];

  // A delegate-backed session so we get progress callbacks. Delegate queue is
  // a background queue; we marshal progress events without blocking.
  NSURLSessionConfiguration *cfg =
      [NSURLSessionConfiguration defaultSessionConfiguration];
  NSURLSession *session =
      [NSURLSession sessionWithConfiguration:cfg
                                    delegate:self
                               delegateQueue:nil];

  NSURLSessionDownloadTask *task = [session downloadTaskWithRequest:request];
  NSNumber *taskKey = @(task.taskIdentifier);
  _downloadResolvers[taskKey]    = [resolve copy];
  _downloadRejecters[taskKey]    = [reject copy];
  _downloadDestinations[taskKey] = [destPath copy];
  [task resume];
}

// Progress → emit event to JS.
- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
      didWriteData:(int64_t)bytesWritten
 totalBytesWritten:(int64_t)totalBytesWritten
totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
  // We only emit if we have a listener; sendEventWithName is safe regardless.
  [self emitProgress:totalBytesWritten total:totalBytesExpectedToWrite];
}

// Completion (success path): move the temp file to the requested destination.
- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location {
  NSNumber *taskKey = @(downloadTask.taskIdentifier);
  RCTPromiseResolveBlock resolve = _downloadResolvers[taskKey];
  RCTPromiseRejectBlock  reject  = _downloadRejecters[taskKey];
  NSString *destPath             = _downloadDestinations[taskKey];

  [self clearTask:taskKey];

  if (!destPath) {
    return; // orphaned callback; nothing to do
  }

  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *moveErr = nil;

  // Remove any stale file at the destination, then move the download in.
  if ([fm fileExistsAtPath:destPath]) {
    [fm removeItemAtPath:destPath error:nil];
  }
  BOOL ok = [fm moveItemAtURL:location
                        toURL:[NSURL fileURLWithPath:destPath]
                        error:&moveErr];

  if (ok) {
    if (resolve) resolve(destPath);
  } else {
    if (reject) reject(@"E_DOWNLOAD_MOVE",
                       moveErr.localizedDescription ?: @"move failed",
                       moveErr);
  }
}

// Completion (error path).
- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
  if (!error) {
    return; // success already handled in didFinishDownloadingToURL
  }
  NSNumber *taskKey = @(task.taskIdentifier);
  RCTPromiseRejectBlock reject = _downloadRejecters[taskKey];
  [self clearTask:taskKey];
  if (reject) {
    reject(@"E_DOWNLOAD", error.localizedDescription, error);
  }
}

- (void)clearTask:(NSNumber *)taskKey {
  [_downloadResolvers removeObjectForKey:taskKey];
  [_downloadRejecters removeObjectForKey:taskKey];
  [_downloadDestinations removeObjectForKey:taskKey];
}

- (void)emitProgress:(int64_t)received total:(int64_t)total {
  // Event emission is wired through the generated base in a later step; for
  // now we post a notification the module's emitter bridges to JS. Keeping
  // this indirection isolated makes the emitter swap a one-line change.
  [[NSNotificationCenter defaultCenter]
      postNotificationName:kDownloadProgressEvent
                    object:nil
                  userInfo:@{ @"received": @(received), @"total": @(total) }];
}

#pragma mark - Unzip (zlib inflate + ZIP container parsing, zip-slip safe)

// ── Little-endian readers over a raw byte buffer ─────────────────────────
static uint16_t AeroReadU16(const uint8_t *p) {
  return (uint16_t)(p[0] | (p[1] << 8));
}
static uint32_t AeroReadU32(const uint8_t *p) {
  return (uint32_t)(p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24));
}

// ── Raw DEFLATE inflate via zlib (windowBits = -15, no zlib/gzip header) ──
static NSData *AeroInflateRaw(const uint8_t *src, uInt srcLen,
                              uint32_t expectedSize) {
  z_stream strm;
  memset(&strm, 0, sizeof(strm));
  strm.next_in  = (Bytef *)src;
  strm.avail_in = srcLen;

  if (inflateInit2(&strm, -MAX_WBITS) != Z_OK) {
    return nil;
  }

  NSUInteger cap = expectedSize > 0 ? expectedSize : (NSUInteger)srcLen * 4 + 64;
  NSMutableData *out = [NSMutableData dataWithCapacity:cap];
  uint8_t buffer[16384];
  int ret;
  do {
    strm.next_out  = buffer;
    strm.avail_out = sizeof(buffer);
    ret = inflate(&strm, Z_NO_FLUSH);
    if (ret == Z_STREAM_ERROR || ret == Z_DATA_ERROR ||
        ret == Z_MEM_ERROR || ret == Z_NEED_DICT) {
      inflateEnd(&strm);
      return nil;
    }
    NSUInteger have = sizeof(buffer) - strm.avail_out;
    if (have > 0) {
      [out appendBytes:buffer length:have];
    }
  } while (ret != Z_STREAM_END);

  inflateEnd(&strm);
  return out;
}

// ── zip-slip guard: resolved child must stay inside destDir ──────────────
static BOOL AeroPathIsInside(NSString *destDir, NSString *candidate) {
  NSString *base = [[destDir stringByStandardizingPath] stringByAppendingString:@"/"];
  NSString *resolved = [candidate stringByStandardizingPath];
  return [resolved hasPrefix:base] || [resolved isEqualToString:[destDir stringByStandardizingPath]];
}

RCT_EXPORT_METHOD(unzipFile:(NSString *)zipPath
                    destDir:(NSString *)destDir
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject) {
  @autoreleasepool {
    NSError *readErr = nil;
    // mappedIfSafe avoids loading the whole archive into resident memory.
    NSData *zip = [NSData dataWithContentsOfFile:zipPath
                                         options:NSDataReadingMappedIfSafe
                                           error:&readErr];
    if (!zip) {
      reject(@"E_UNZIP_READ",
             readErr.localizedDescription ?: @"cannot read zip", readErr);
      return;
    }

    const uint8_t *bytes = (const uint8_t *)zip.bytes;
    const NSUInteger len = zip.length;
    if (len < 22) {
      reject(@"E_UNZIP_FORMAT", @"file too small to be a zip", nil);
      return;
    }

    NSFileManager *fm = [NSFileManager defaultManager];
    [fm createDirectoryAtPath:destDir
  withIntermediateDirectories:YES
                   attributes:nil
                        error:nil];

    // ── Locate End Of Central Directory (scan backward for 0x06054b50) ──
    NSInteger eocd = -1;
    NSUInteger scanStart = len - 22;
    NSUInteger scanFloor = (len > 22 + 65535) ? (len - 22 - 65535) : 0;
    for (NSInteger i = (NSInteger)scanStart; i >= (NSInteger)scanFloor; i--) {
      if (AeroReadU32(bytes + i) == 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) {
      reject(@"E_UNZIP_EOCD", @"end-of-central-directory not found", nil);
      return;
    }

    uint16_t totalEntries = AeroReadU16(bytes + eocd + 10);
    uint32_t cdOffset     = AeroReadU32(bytes + eocd + 16);
    if (cdOffset >= len) {
      reject(@"E_UNZIP_CD", @"central directory offset out of range", nil);
      return;
    }

    // ── Walk the central directory ──────────────────────────────────────
    NSUInteger p = cdOffset;
    for (uint16_t e = 0; e < totalEntries; e++) {
      if (p + 46 > len || AeroReadU32(bytes + p) != 0x02014b50) {
        reject(@"E_UNZIP_CDENTRY", @"malformed central directory entry", nil);
        return;
      }

      uint16_t method       = AeroReadU16(bytes + p + 10);
      uint32_t compSize      = AeroReadU32(bytes + p + 20);
      uint32_t uncompSize    = AeroReadU32(bytes + p + 24);
      uint16_t nameLen       = AeroReadU16(bytes + p + 28);
      uint16_t extraLenCD    = AeroReadU16(bytes + p + 30);
      uint16_t commentLen    = AeroReadU16(bytes + p + 32);
      uint32_t localOffset   = AeroReadU32(bytes + p + 42);

      NSString *name = [[NSString alloc] initWithBytes:(bytes + p + 46)
                                                length:nameLen
                                              encoding:NSUTF8StringEncoding];
      // advance central-directory cursor to the next entry
      p += 46 + nameLen + extraLenCD + commentLen;

      if (name.length == 0) { continue; }

      NSString *fullPath = [destDir stringByAppendingPathComponent:name];
      if (!AeroPathIsInside(destDir, fullPath)) {
        reject(@"E_UNZIP_SLIP",
               [NSString stringWithFormat:@"unsafe path in zip: %@", name], nil);
        return;
      }

      // Directory entry (names ending in '/') → just create it.
      if ([name hasSuffix:@"/"]) {
        [fm createDirectoryAtPath:fullPath
      withIntermediateDirectories:YES
                       attributes:nil
                            error:nil];
        continue;
      }

      // Ensure parent directory exists.
      [fm createDirectoryAtPath:[fullPath stringByDeletingLastPathComponent]
    withIntermediateDirectories:YES
                     attributes:nil
                          error:nil];

      // ── Resolve data start via the LOCAL header (its name/extra lengths
      //    can differ from the central directory's) ──────────────────────
      if (localOffset + 30 > len ||
          AeroReadU32(bytes + localOffset) != 0x04034b50) {
        reject(@"E_UNZIP_LOCAL", @"malformed local file header", nil);
        return;
      }
      uint16_t localNameLen  = AeroReadU16(bytes + localOffset + 26);
      uint16_t localExtraLen = AeroReadU16(bytes + localOffset + 28);
      NSUInteger dataStart = localOffset + 30 + localNameLen + localExtraLen;

      if (dataStart + compSize > len) {
        reject(@"E_UNZIP_BOUNDS", @"entry data out of range", nil);
        return;
      }

      const uint8_t *comp = bytes + dataStart;
      NSData *fileData = nil;

      if (method == 0) {
        // Stored — copy as-is.
        fileData = [NSData dataWithBytes:comp length:compSize];
      } else if (method == 8) {
        // Deflate — inflate via zlib.
        fileData = AeroInflateRaw(comp, (uInt)compSize, uncompSize);
        if (!fileData) {
          reject(@"E_UNZIP_INFLATE",
                 [NSString stringWithFormat:@"inflate failed for %@", name], nil);
          return;
        }
      } else {
        reject(@"E_UNZIP_METHOD",
               [NSString stringWithFormat:@"unsupported method %d for %@",
                                          method, name], nil);
        return;
      }

      if (![fileData writeToFile:fullPath atomically:YES]) {
        reject(@"E_UNZIP_WRITE",
               [NSString stringWithFormat:@"failed writing %@", name], nil);
        return;
      }
    }

    resolve(destDir);
  }
}

#pragma mark - File system helpers (NSFileManager)

RCT_EXPORT_METHOD(fileExists:(NSString *)path
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject) {
  BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:path];
  resolve(@(exists));
}

RCT_EXPORT_METHOD(deletePath:(NSString *)path
                     resolve:(RCTPromiseResolveBlock)resolve
                      reject:(RCTPromiseRejectBlock)reject) {
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:path]) {
    resolve(nil); // no-op if absent, per spec
    return;
  }
  NSError *err = nil;
  [fm removeItemAtPath:path error:&err];
  if (err) {
    reject(@"E_DELETE", err.localizedDescription, err);
  } else {
    resolve(nil);
  }
}

RCT_EXPORT_METHOD(movePath:(NSString *)srcPath
                  destPath:(NSString *)destPath
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject) {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *destDir = [destPath stringByDeletingLastPathComponent];
  [fm createDirectoryAtPath:destDir
withIntermediateDirectories:YES
                 attributes:nil
                      error:nil];
  if ([fm fileExistsAtPath:destPath]) {
    [fm removeItemAtPath:destPath error:nil];
  }
  NSError *err = nil;
  [fm moveItemAtPath:srcPath toPath:destPath error:&err];
  if (err) {
    reject(@"E_MOVE", err.localizedDescription, err);
  } else {
    resolve(nil);
  }
}

RCT_EXPORT_METHOD(listDir:(NSString *)path
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject) {
  NSError *err = nil;
  NSArray<NSString *> *items =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:path error:&err];
  if (err) {
    reject(@"E_LISTDIR", err.localizedDescription, err);
  } else {
    resolve(items ?: @[]);
  }
}

- (NSString *)getDocumentsPath {
  NSArray<NSString *> *paths =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                          NSUserDomainMask, YES);
  return paths.firstObject ?: @"";
}

#pragma mark - Crash guard (Layer 1 counter mutation from JS)

RCT_EXPORT_METHOD(markBundleHealthy:(RCTPromiseResolveBlock)resolve
                             reject:(RCTPromiseRejectBlock)reject) {
  NSUserDefaults *defaults = [Aeropush defaults];
  // App mounted successfully → clear the in-progress launch failures and
  // promote the active bundle to "known good" (drop the rollback target).
  [defaults setInteger:0 forKey:kLaunchFailureCountKey];
  [defaults removeObjectForKey:kPreviousBundlePathKey];
  [defaults synchronize];
  resolve(nil);
}

RCT_EXPORT_METHOD(markBundleFailed:(NSString *)reason
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject) {
  NSUserDefaults *defaults = [Aeropush defaults];
  // Force the counter to/over threshold so the very next launch rolls back,
  // regardless of how many launches had accumulated.
  [defaults setInteger:kLaunchFailureThreshold forKey:kLaunchFailureCountKey];
  [defaults synchronize];
  RCTLogWarn(@"[AeroPush] bundle marked failed: %@", reason);
  resolve(nil);
}

RCT_EXPORT_METHOD(getLaunchFailureCount:(RCTPromiseResolveBlock)resolve
                                 reject:(RCTPromiseRejectBlock)reject) {
  NSInteger count = [[Aeropush defaults] integerForKey:kLaunchFailureCountKey];
  resolve(@(count));
}

- (NSNumber *)isRunningBundle {
  NSString *path = [Aeropush activeBundlePath];
  BOOL running = (path.length > 0) &&
      [[NSFileManager defaultManager] fileExistsAtPath:path];
  return @(running);
}

#pragma mark - Restart (JS runtime reload)

RCT_EXPORT_METHOD(restart) {
  // Must run on the main queue: it tears down and rebuilds the RN surface.
  dispatch_async(dispatch_get_main_queue(), ^{
    RCTTriggerReloadCommandListeners(@"AeroPush update applied");
  });
}

#pragma mark - Fingerprint

- (NSString *)getNativeFingerprint {
  NSString *fp = [[NSBundle mainBundle]
      objectForInfoDictionaryKey:kFingerprintInfoPlistKey];
  return fp ?: @"";
}

#pragma mark - Event emitter plumbing

RCT_EXPORT_METHOD(addListener:(NSString *)eventName) {
  // No-op: NativeEventEmitter bookkeeping. Retained so the spec matches.
}

RCT_EXPORT_METHOD(removeListeners:(double)count) {
  // No-op: NativeEventEmitter bookkeeping.
}

@end
