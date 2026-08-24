#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>

int main(void) {
  @autoreleasepool {
    CFArrayRef rawWindows = CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID
    );
    NSArray *windows = CFBridgingRelease(rawWindows);
    for (NSDictionary *window in windows) {
      NSString *owner = window[(id)kCGWindowOwnerName];
      NSString *windowName = window[(id)kCGWindowName] ?: @"";
      if (![owner localizedCaseInsensitiveContainsString:@"Pixice"] &&
          ![owner isEqualToString:@"Electron"] &&
          ![windowName localizedCaseInsensitiveContainsString:@"Pixice"]) continue;
      NSNumber *windowId = window[(id)kCGWindowNumber];
      NSString *name = windowName;
      NSDictionary *bounds = window[(id)kCGWindowBounds];
      NSNumber *layer = window[(id)kCGWindowLayer];
      printf("owner=%s id=%u layer=%d name=%s x=%d y=%d width=%d height=%d\n",
        owner.UTF8String,
        windowId.unsignedIntValue,
        layer.intValue,
        name.UTF8String,
        [bounds[@"X"] intValue],
        [bounds[@"Y"] intValue],
        [bounds[@"Width"] intValue],
        [bounds[@"Height"] intValue]
      );
    }
  }
  return 0;
}
