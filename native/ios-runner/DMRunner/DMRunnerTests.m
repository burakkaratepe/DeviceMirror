// Device Mirror touch runner.
//
// A single long-running UI "test" that listens on a TCP port on the device.
// The Mac reaches it through usbmuxd (no HTTP, no JSON, no iproxy) and sends
// small binary commands; each becomes ONE synthesized event, sent straight to
// the XCTest daemon without XCUITest's quiescence waits or accessibility
// queries.
//
// Apple's daemon runs one event at a time and stays busy ~260 ms per event
// (measured on Xcode 26 / iOS 27; events sent meanwhile are rejected, and HID
// recording playback is slower still), so a whole gesture always travels as a
// single event: a tap, a long press, or a complete drag path with its timing.
//
// Wire format (little endian).
// Mac → device: header 8 bytes  u8 op, u8 pad, u16 count, u32 seq
//   op 1 tap      payload f32 x, f32 y, f32 holdSeconds
//   op 2 gesture  payload count × (f32 x, f32 y, f32 seconds since start)
//   op 3 text     payload count bytes of UTF-8
//   op 4 home
//   op 5 hardware button  payload f32 button (2 volume up, 3 volume down, 100 lock)
//   op 6 ping
//   op 7 wake (a Shift key press: wakes a sleeping screen, harmless when it is on)
//   x/y are normalized 0…1 of the portrait screen.
// Device → Mac:
//   hello 16 bytes: u8 0x80, u8 version, u8 pad[2], f32 width pt, f32 height pt, f32 scale
//   ack   12 bytes: u8 0x81, u8 ok, u8 pad[2], u32 seq, u32 micros (received → delivered)

#import <XCTest/XCTest.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <sys/socket.h>
#import <mach/mach_time.h>
#import "XCTestPrivate.h"

static const uint16_t kPort = 47310;
static const uint8_t kProtocolVersion = 1;

typedef struct __attribute__((packed)) {
  uint8_t op;
  uint8_t pad;
  uint16_t count;
  uint32_t seq;
} DMHeader;

static double nowMicros(void) {
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  return (double)mach_absolute_time() * tb.numer / tb.denom / 1000.0;
}

static BOOL readFully(int fd, void *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = recv(fd, (uint8_t *)buf + got, n - got, 0);
    if (r <= 0) return NO;
    got += (size_t)r;
  }
  return YES;
}

static void onMain(dispatch_block_t block) {
  if (NSThread.isMainThread) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

/// Presses a hardware key as a HID event (usage page / usage), like a real
/// key press. XCUIDevice's volume buttons are logged as pressed but change
/// nothing on recent iOS versions; the HID route works. Private API, looked
/// up at run time.
static BOOL pressHID(uint32_t page, uint32_t usage, double seconds) {
  Class eventClass = NSClassFromString(@"XCDeviceEvent");
  SEL make = NSSelectorFromString(@"deviceEventWithPage:usage:duration:");
  SEL perform = NSSelectorFromString(@"performDeviceEvent:error:");
  XCUIDevice *device = XCUIDevice.sharedDevice;
  if (!eventClass || ![eventClass respondsToSelector:make] || ![device respondsToSelector:perform]) return NO;
  id event = ((id (*)(id, SEL, uint32_t, uint32_t, double))[eventClass methodForSelector:make])(eventClass, make, page, usage, seconds);
  __block BOOL ok = NO;
  onMain(^{
    NSError *error = nil;
    ok = ((BOOL (*)(id, SEL, id, NSError **))[device methodForSelector:perform])(device, perform, event, &error);
    if (!ok) NSLog(@"[DMRunner] HID %x/%x failed: %@", page, usage, error);
  });
  return ok;
}

#pragma mark - Event synthesis

// Private classes are looked up at run time: they have moved between XCTest
// frameworks across Xcode versions, so linking to one would be fragile.
static XCPointerEventPath *touchPath(CGPoint p) {
  return [[NSClassFromString(@"XCPointerEventPath") alloc] initForTouchAtPoint:p offset:0];
}

/// The test daemon's proxy: calling it directly skips the wrapper's extra work.
static id daemonProxy(void) {
  static id proxy;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    proxy = [[NSClassFromString(@"XCTRunnerDaemonSession") sharedSession] valueForKey:@"daemonProxy"];
  });
  return proxy;
}

/// Sends one event record and waits for delivery (the daemon takes one at a time).
static BOOL synthesize(XCPointerEventPath *path) {
  XCSynthesizedEventRecord *record = [[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:@"Single-Finger Touch Action" interfaceOrientation:UIInterfaceOrientationPortrait];
  [record addPointerEventPath:path];
  SEL sel = NSSelectorFromString(@"_XCT_synthesizeEvent:completion:");
  id proxy = daemonProxy();
  void (*call)(id, SEL, id, void (^)(NSError *)) = (void *)[proxy methodForSelector:sel];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSError *failure = nil;
  call(proxy, sel, record, ^(NSError *error) {
    failure = error;
    dispatch_semaphore_signal(done);
  });
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) != 0) return NO;
  if (failure) NSLog(@"[DMRunner] event failed: %@", failure);
  return failure == nil;
}

@interface DMRunnerTests : XCTestCase
@end

@implementation DMRunnerTests {
  CGSize _screen; // portrait size in points
  dispatch_queue_t _events;
}

- (void)testServe {
  self.continueAfterFailure = YES;
  // The runner app runs in a legacy-size compatibility window (UIScreen says
  // 320x480), so ask SpringBoard for the real screen size once at start.
  XCUIApplication *springboard = [[XCUIApplication alloc] initWithBundleIdentifier:@"com.apple.springboard"];
  _screen = springboard.frame.size;
  if (_screen.width <= 0) _screen = UIScreen.mainScreen.bounds.size;
  if (_screen.width > _screen.height) _screen = CGSizeMake(_screen.height, _screen.width);
  _events = dispatch_queue_create("dm.events", DISPATCH_QUEUE_SERIAL);
  [NSThread detachNewThreadWithBlock:^{ [self serve]; }];
  NSLog(@"[DMRunner] listening on %u, screen %.0fx%.0f", kPort, _screen.width, _screen.height);
  while (YES) {
    @autoreleasepool { [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3600]]; }
  }
}

#pragma mark - Socket server

- (void)serve {
  int server = socket(AF_INET6, SOCK_STREAM, 0);
  int yes = 1, no = 0;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  setsockopt(server, IPPROTO_IPV6, IPV6_V6ONLY, &no, sizeof(no));
  struct sockaddr_in6 addr = {0};
  addr.sin6_len = sizeof(addr);
  addr.sin6_family = AF_INET6;
  addr.sin6_port = htons(kPort);
  addr.sin6_addr = in6addr_any;
  if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) != 0 || listen(server, 4) != 0) {
    NSLog(@"[DMRunner] bind failed: %d", errno);
    return;
  }
  while (YES) {
    int client = accept(server, NULL, NULL);
    if (client < 0) continue;
    setsockopt(client, IPPROTO_TCP, TCP_NODELAY, &yes, sizeof(yes));
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    [self handle:client];
    close(client);
  }
}

- (void)handle:(int)fd {
  uint8_t hello[16] = {0x80, kProtocolVersion};
  float dims[3] = {(float)_screen.width, (float)_screen.height, (float)UIScreen.mainScreen.nativeScale};
  memcpy(hello + 4, dims, sizeof(dims));
  send(fd, hello, sizeof(hello), 0);

  DMHeader h;
  while (readFully(fd, &h, sizeof(h))) {
    double received = nowMicros();
    size_t payloadSize = 0;
    switch (h.op) {
      case 1: case 5: payloadSize = 12; break;
      case 2: payloadSize = (size_t)h.count * 12; break;
      case 3: payloadSize = h.count; break;
      default: payloadSize = 0;
    }
    NSMutableData *payload = [NSMutableData dataWithLength:payloadSize];
    if (payloadSize && !readFully(fd, payload.mutableBytes, payloadSize)) break;
    uint8_t op = h.op;
    uint16_t count = h.count;
    uint32_t seq = h.seq;
    dispatch_async(_events, ^{
      BOOL ok = [self perform:op count:count payload:payload];
      uint8_t ack[12] = {0x81, ok ? 1 : 0};
      uint32_t micros = (uint32_t)(nowMicros() - received);
      memcpy(ack + 4, &seq, 4);
      memcpy(ack + 8, &micros, 4);
      send(fd, ack, sizeof(ack), 0);
    });
  }
}

- (CGPoint)point:(const float *)xy {
  return CGPointMake(xy[0] * _screen.width, xy[1] * _screen.height);
}

- (BOOL)perform:(uint8_t)op count:(uint16_t)count payload:(NSData *)payload {
  const float *f = payload.bytes;
  switch (op) {
    case 1: { // tap / long press
      XCPointerEventPath *path = touchPath([self point:f]);
      [path liftUpAtOffset:MAX(0.02, f[2])];
      return synthesize(path);
    }
    case 2: { // full drag path with its real timing
      if (count < 2) return NO;
      XCPointerEventPath *path = touchPath([self point:f]);
      double last = 0;
      for (uint16_t i = 1; i < count; i++) {
        const float *pt = f + i * 3;
        last = MAX(last + 0.001, pt[2]);
        [path moveToPoint:[self point:pt] atOffset:last];
      }
      [path liftUpAtOffset:last + 0.01];
      return synthesize(path);
    }
    case 3: { // text
      NSString *text = [[NSString alloc] initWithData:payload encoding:NSUTF8StringEncoding];
      if (!text.length) return YES;
      XCPointerEventPath *path = [[NSClassFromString(@"XCPointerEventPath") alloc] initForTextInput];
      [path typeText:text atOffset:0 typingSpeed:60 shouldRedact:NO];
      return synthesize(path);
    }
    case 4:
      onMain(^{ [XCUIDevice.sharedDevice pressButton:XCUIDeviceButtonHome]; });
      return YES;
    case 5: { // side buttons (XCUIDevice expects the main thread)
      int button = (int)f[0];
      if (button == 100) { // lock / wake: private XCUIDevice method (no public API)
        SEL lock = NSSelectorFromString(@"pressLockButton");
        if (![XCUIDevice.sharedDevice respondsToSelector:lock]) return NO;
        NSLog(@"[DMRunner] lock button");
        onMain(^{ ((void (*)(id, SEL))[XCUIDevice.sharedDevice methodForSelector:lock])(XCUIDevice.sharedDevice, lock); });
        NSLog(@"[DMRunner] lock button done");
        return YES;
      }
      // Volume: consumer page 0x0C, usage 0xE9 up / 0xEA down.
      if (button == 2 || button == 3) {
        if (pressHID(0x0C, button == 2 ? 0xE9 : 0xEA, 0.05)) return YES;
#if !TARGET_OS_SIMULATOR
        onMain(^{ [XCUIDevice.sharedDevice pressButton:button == 2 ? XCUIDeviceButtonVolumeUp : XCUIDeviceButtonVolumeDown]; });
        return YES;
#endif
      }
      return NO;
    }
    case 7: // wake: an external keyboard key wakes the display like on a real iPhone
      return pressHID(0x07, 0xE1, 0.05); // keyboard page, Left Shift
    default: // ping
      return YES;
  }
}

@end
