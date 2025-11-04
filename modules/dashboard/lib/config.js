"use strict";

const { DEFAULT_MODULE_WIDGETS } = require("./constants");
const { isNonEmptyArray, isNonEmptyObject } = require("./validation");

function createDashboardConfig(widgetsOption, architectureDesign) {
  let moduleWidgets = DEFAULT_MODULE_WIDGETS;
  let architectureWidgets = [];

  if (Array.isArray(widgetsOption)) {
    architectureWidgets = widgetsOption;
  } else if (widgetsOption && typeof widgetsOption === "object") {
    if (isNonEmptyArray(widgetsOption.modules)) {
      moduleWidgets = widgetsOption.modules;
    }
    if (Array.isArray(widgetsOption.architecture)) {
      architectureWidgets = widgetsOption.architecture;
    } else if (isNonEmptyArray(widgetsOption.widgets)) {
      architectureWidgets = widgetsOption.widgets;
    }
  }

  return {
    widgets: moduleWidgets,
    moduleWidgets,
    architectureWidgets,
    architectureDesign: isNonEmptyObject(architectureDesign) ? architectureDesign : null,
  };
}

module.exports = {
  createDashboardConfig,
};
