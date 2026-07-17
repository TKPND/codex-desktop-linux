"use strict";

function createOptions() {
  return {
    discovery: {
      findWLDevices() {
        return [];
      },
    },
    createComm() {
      throw new Error("No virtual Codex Micro is discoverable");
    },
  };
}

module.exports = { createOptions };
