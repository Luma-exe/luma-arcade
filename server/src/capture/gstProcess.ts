import { ManagedProcess } from "../process/managedProcess.js";

export const capturePipeline = new ManagedProcess("gst-launch-1.0", "gstreamer");
