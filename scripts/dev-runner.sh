#!/bin/sh
# Dev helper: build the iOS touch runner unsigned, re-sign it with a keychain
# identity + profile, and run it on a device with xcodebuild.
#   scripts/dev-runner.sh <profile.mobileprovision> <udid>
set -e
PROF="$1"; UDID="$2"
DD=/tmp/dmr-dd; W=/tmp/dmr-signed
xcodebuild build-for-testing -project native/ios-runner/DeviceMirrorRunner.xcodeproj -scheme DeviceMirrorRunner \
  -configuration Release -destination 'generic/platform=iOS' -derivedDataPath $DD CODE_SIGNING_ALLOWED=NO -quiet
rm -rf $W; mkdir -p $W
cp -R $DD/Build/Products/Release-iphoneos $W/
cp $DD/Build/Products/*.xctestrun $W/runner.xctestrun
/usr/libexec/PlistBuddy -c "Delete :TestConfigurations:0:TestTargets:0:DSTROOTPath" $W/runner.xctestrun 2>/dev/null || true
APP=$W/Release-iphoneos/DeviceMirrorRunner-Runner.app
SHA=$(security find-identity -v -p codesigning | grep -oE "[0-9A-F]{40}" | head -1)
security cms -D -i "$PROF" > $W/profile.plist
TEAM=$(/usr/libexec/PlistBuddy -c "Print :TeamIdentifier:0" $W/profile.plist)
BID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" $APP/Info.plist)
/usr/libexec/PlistBuddy -x -c "Print :Entitlements" $W/profile.plist > $W/ent.plist
/usr/libexec/PlistBuddy -c "Set :application-identifier $TEAM.$BID" $W/ent.plist
cp "$PROF" $APP/embedded.mobileprovision
for f in $APP/Frameworks/* $APP/PlugIns/DeviceMirrorRunner.xctest; do codesign -f -s $SHA --timestamp=none "$f" 2>/dev/null; done
codesign -f -s $SHA --timestamp=none --entitlements $W/ent.plist --generate-entitlement-der $APP 2>/dev/null
codesign --verify --deep --strict $APP
echo "signed; starting on $UDID"
exec xcodebuild test-without-building -xctestrun $W/runner.xctestrun -destination "id=$UDID"
