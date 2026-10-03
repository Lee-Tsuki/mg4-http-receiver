"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setActiveTrackingCalibrationProfile = setActiveTrackingCalibrationProfile;
exports.getActiveTrackingCalibrationProfile = getActiveTrackingCalibrationProfile;
exports.clearActiveTrackingCalibrationProfile = clearActiveTrackingCalibrationProfile;
let activeTrackingCalibrationProfile = null;
function setActiveTrackingCalibrationProfile(profile) {
    activeTrackingCalibrationProfile = profile;
}
function getActiveTrackingCalibrationProfile() {
    return activeTrackingCalibrationProfile;
}
function clearActiveTrackingCalibrationProfile() {
    activeTrackingCalibrationProfile = null;
}
