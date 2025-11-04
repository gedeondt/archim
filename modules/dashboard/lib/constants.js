"use strict";

const path = require("path");

const MODULE_ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(MODULE_ROOT, "public");
const DASHBOARD_HTML = path.join(PUBLIC_DIR, "index.html");
const DASHBOARD_SCRIPT = path.join(PUBLIC_DIR, "dashboard.js");
const MODULES_DIR = path.join(MODULE_ROOT, "..");

const DEFAULT_MODULE_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
    props: {
      "metrics-url": "http://localhost:4200/metrics",
      "queues-url": "http://localhost:4200/queues",
    },
    readmeModule: "queue",
  },
  {
    id: "event-log-monitor",
    title: "Event Log",
    url: "http://localhost:4400/microfrontends/event-log-monitor.js",
    tagName: "event-log-monitor",
    props: {
      "metrics-url": "http://localhost:4400/metrics",
    },
    readmeModule: "event-log",
  },
  {
    id: "mysql-simulator",
    title: "MySQL Simulator",
    url: "http://localhost:4500/microfrontends/mysql-simulator.js",
    tagName: "mysql-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4500/metrics",
    },
    readmeModule: "mysql-simulator",
  },
  {
    id: "dynamodb-simulator",
    title: "DynamoDB Simulator",
    url: "http://localhost:4600/microfrontends/dynamodb-simulator.js",
    tagName: "dynamodb-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4600/metrics",
    },
    readmeModule: "dynamodb-simulator",
  },
  {
    id: "redis-simulator",
    title: "Redis Simulator",
    url: "http://localhost:4700/microfrontends/redis-simulator.js",
    tagName: "redis-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4700/metrics",
    },
    readmeModule: "redis-simulator",
  },
  {
    id: "s3-simulator",
    title: "S3 Simulator",
    url: "http://localhost:4800/widget",
    tagName: "s3-simulator-widget",
    props: {
      "metrics-url": "http://localhost:4800/metrics",
    },
    readmeModule: "s3-simulator",
  },
];

module.exports = {
  MODULE_ROOT,
  PUBLIC_DIR,
  DASHBOARD_HTML,
  DASHBOARD_SCRIPT,
  MODULES_DIR,
  DEFAULT_MODULE_WIDGETS,
};
