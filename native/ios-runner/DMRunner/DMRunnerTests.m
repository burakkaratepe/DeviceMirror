// Device Mirror touch runner.
//
// A single long-running UI "test" that listens on a TCP port on the device.
// The Mac reaches it through usbmuxd (no HTTP, no JSON, no iproxy) and sends
// fixed-size binary commands; each one becomes a synthesized touch event
// immediately, without XCUITest's quiescence waits or accessibility queries.
//
// Wire format (little endian).
// Mac → device, 16 bytes:  u8 op, u8 pad[3], f32 x, f32 y, u32 seq
//   op 1 down, 2 move, 3 up, 4 tap, 5 home, 6 ping
//   x/y are normalized 0…1 of the portrait screen.
// Device → Mac:
//   hello  16 bytes: u8 0x80, u8 pad[3], f32 width pt, f32 height pt, f32 scale
//   ack    12 bytes: u8 0x81, u8 ok, u8 pad[2], u32 seq, u32 micros (receive → event delivered)

#import <XCTest/XCTest.h>
#import <netinet/in.h>
#import <netinet/tcp.h>
#import <sys/socket.h>
#import <mach/mach_time.h>
#import "XCTestPrivate.h"

static const uint16_t kPort = 47310;

typedef struct __attribute__((packed)) {
  uint8_t op;
  uint8_t pad[3];
  float x;
  float y;
  uint32_t seq;
} DMCommand;

static double nowMicros(void) {
  static mach_timebase_info_data_t tb;
  if (tb.denom == 0) mach_timebase_info(&tb);
  return (double)mach_absolute_time() * tb.numer / tb.denom / 1000.0;
}

static XCPointerEventPath *touchPath(CGPoint p);

@interface DMRunnerTests : XCTestCase
@end

@implementation DMRunnerTests {
  CGSize _screen;        // portrait size in points
  CGPoint _last;         // last touch position (points)
  BOOL _down;
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
  // Keep the test (and thus the runner process) alive forever.
  while (YES) {
    @autoreleasepool { [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:3600]]; }
  }
}

#pragma mark - Socket server

- (void)serve {
  int server = socket(AF_INET6, SOCK_STREAM, 0);
  int yes = 1, no = 0;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  setsockopt(server, IPPROTO_IPV6, IPV6_V6ONLY, &no, sizeof(no)); // accept IPv4 too
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

static BOOL readFully(int fd, void *buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = recv(fd, (uint8_t *)buf + got, n - got, 0);
    if (r <= 0) return NO;
    got += (size_t)r;
  }
  return YES;
}

- (void)handle:(int)fd {
  uint8_t hello[16] = {0x80};
  float dims[3] = {(float)_screen.width, (float)_screen.height, (float)UIScreen.mainScreen.nativeScale};
  memcpy(hello + 4, dims, sizeof(dims));
  send(fd, hello, sizeof(hello), 0);

  DMCommand cmd;
  while (readFully(fd, &cmd, sizeof(cmd))) {
    double received = nowMicros();
    CGPoint p = CGPointMake(cmd.x * _screen.width, cmd.y * _screen.height);
    uint32_t seq = cmd.seq;
    uint8_t op = cmd.op;
    if (op == 0x44) { // experimental: async tap, ack when the daemon reports completion
      XCPointerEventPath *path = touchPath(p);
      [path liftUpAtOffset:0.03];
      [self synthesizeAsync:path done:^(BOOL ok) {
        uint8_t ack[12] = {0x81, ok ? 1 : 0};
        uint32_t micros = (uint32_t)(nowMicros() - received);
        memcpy(ack + 4, &seq, 4);
        memcpy(ack + 8, &micros, 4);
        send(fd, ack, sizeof(ack), 0);
      }];
      continue;
    }
    dispatch_async(_events, ^{
      BOOL ok = [self perform:op at:p];
      uint8_t ack[12] = {0x81, ok ? 1 : 0};
      uint32_t micros = (uint32_t)(nowMicros() - received);
      memcpy(ack + 4, &seq, 4);
      memcpy(ack + 8, &micros, 4);
      send(fd, ack, sizeof(ack), 0);
    });
  }
  // Connection gone: never leave a finger on the screen.
  dispatch_async(_events, ^{ if (self->_down) [self perform:3 at:self->_last]; });
}

#pragma mark - Events

// Private classes are looked up at run time: they have moved between XCTest
// frameworks across Xcode versions, so linking to one would be fragile.
static XCPointerEventPath *touchPath(CGPoint p) {
  return [[NSClassFromString(@"XCPointerEventPath") alloc] initForTouchAtPoint:p offset:0];
}

/// The test daemon's proxy. Calling it directly skips the extra settling the
/// XCTRunnerDaemonSession wrapper adds after each event.
static id daemonProxy(void) {
  static id proxy;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    id session = [NSClassFromString(@"XCTRunnerDaemonSession") sharedSession];
    proxy = [session valueForKey:@"daemonProxy"];
  });
  return proxy;
}

/// Fire-and-forget straight to the daemon; completion reports delivery.
- (void)synthesizeAsync:(XCPointerEventPath *)path done:(void (^)(BOOL ok))done {
  XCSynthesizedEventRecord *record = [[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:@"Single-Finger Touch Action" interfaceOrientation:UIInterfaceOrientationPortrait];
  [record addPointerEventPath:path];
  id proxy = daemonProxy();
  // The daemon waits an "implicit confirmation interval" after each event
  // before it reports completion and accepts the next one; ask for none.
  SEL sel = NSSelectorFromString(@"_XCT_synthesizeEvent:implicitConfirmationInterval:completion:");
  void (*call)(id, SEL, id, double, void (^)(NSError *)) = (void *)[proxy methodForSelector:sel];
  call(proxy, sel, record, 0.001, ^(NSError *error) {
    if (error) NSLog(@"[DMRunner] daemon event failed: %@", error);
    done(error == nil);
  });
}

/// Runs one synthesized event and waits for delivery, so events stay ordered.
- (BOOL)synthesize:(XCPointerEventPath *)path {
  XCSynthesizedEventRecord *record = [[NSClassFromString(@"XCSynthesizedEventRecord") alloc] initWithName:nil interfaceOrientation:UIInterfaceOrientationPortrait];
  [record addPointerEventPath:path];
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  __block NSError *failure = nil;
  __block BOOL success = NO;
  [[NSClassFromString(@"XCTRunnerDaemonSession") sharedSession] synthesizeEvent:record completion:^(BOOL ok, NSError *error) {
    success = ok;
    failure = error;
    dispatch_semaphore_signal(done);
  }];
  dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC));
  if (!success) NSLog(@"[DMRunner] event failed: %@", failure);
  return success;
}

- (BOOL)perform:(uint8_t)op at:(CGPoint)p {
  switch (op) {
    case 1: { // down: finger stays on the glass until "up"
      XCPointerEventPath *path = touchPath(p);
      _down = YES;
      _last = p;
      return [self synthesize:path];
    }
    case 2: { // move
      if (!_down) return YES;
      XCPointerEventPath *path = touchPath(_last);
      [path moveToPoint:p atOffset:0.001];
      _last = p;
      return [self synthesize:path];
    }
    case 3: { // up
      XCPointerEventPath *path = touchPath(_down ? _last : p);
      [path liftUpAtOffset:0.001];
      _down = NO;
      return [self synthesize:path];
    }
    case 4: { // tap in one event
      XCPointerEventPath *path = touchPath(p);
      [path liftUpAtOffset:0.03];
      return [self synthesize:path];
    }
    case 5: {
      [XCUIDevice.sharedDevice pressButton:XCUIDeviceButtonHome];
      return YES;
    }
    default: // ping
      return YES;
  }
}

@end
