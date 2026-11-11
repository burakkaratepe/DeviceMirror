// Private XCTest / XCUIAutomation interfaces used to inject touches directly.
// They are what XCUICoordinate uses internally, minus its waiting for the app
// to become idle and its accessibility snapshots — which is where most of the
// latency of WebDriverAgent-style taps comes from. Verified present in
// Xcode 26 (XCUIAutomation.framework, XCTestCore.framework).

#import <UIKit/UIKit.h>
#import <XCTest/XCTest.h>

NS_ASSUME_NONNULL_BEGIN

@interface XCPointerEventPath : NSObject
- (instancetype)initForTouchAtPoint:(CGPoint)point offset:(double)offset;
- (void)pressDownAtOffset:(double)offset;
- (void)moveToPoint:(CGPoint)point atOffset:(double)offset;
- (void)liftUpAtOffset:(double)offset;
@end

@interface XCSynthesizedEventRecord : NSObject
- (instancetype)initWithName:(nullable NSString *)name interfaceOrientation:(UIInterfaceOrientation)orientation;
- (void)addPointerEventPath:(XCPointerEventPath *)path;
@end

@interface XCTRunnerDaemonSession : NSObject
+ (instancetype)sharedSession;
// The completion's first argument is a success flag (verified from a crash
// report on Xcode 26: passing it as an object segfaults).
- (void)synthesizeEvent:(XCSynthesizedEventRecord *)event completion:(void (^)(BOOL success, NSError *_Nullable error))completion;
@end

NS_ASSUME_NONNULL_END
