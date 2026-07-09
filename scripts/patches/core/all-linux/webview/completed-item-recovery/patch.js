"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxCompletedItemRecoveryPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-completed-item-recovery",
    phase: "webview-asset",
    order: 1043,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~.*\.js$/,
    missingDescription: "app-server conversation manager bundle",
    skipDescription: "Linux completed item recovery patch",
    apply: applyLinuxCompletedItemRecoveryPatch,
  }),
];
