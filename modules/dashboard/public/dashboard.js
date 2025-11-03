import React, { useEffect, useState, useRef } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

const { createElement } = React;

const DEFAULT_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
  },
  {
    id: "mysql-simulator",
    title: "MySQL Simulator",
    url: "http://localhost:4500/microfrontends/mysql-simulator.js",
    tagName: "mysql-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4500/metrics",
    },
  },
  {
    id: "dynamodb-simulator",
    title: "DynamoDB Simulator",
    url: "http://localhost:4600/microfrontends/dynamodb-simulator.js",
    tagName: "dynamodb-simulator-dashboard",
    props: {
      "metrics-url": "http://localhost:4600/metrics",
    },
  },
  {
    id: "s3-simulator",
    title: "S3 Simulator",
    url: "http://localhost:4800/widget",
    tagName: "s3-simulator-widget",
    props: {
      "metrics-url": "http://localhost:4800/metrics",
    },
  },
];

function loadMicrofrontendScript(url) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-microfrontend='${url}']`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.microfrontend = url;
    script.onload = () => resolve();
    script.onerror = (error) => reject(error);
    document.head.appendChild(script);
  });
}

function WidgetContainer({ widget }) {
  const [error, setError] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    loadMicrofrontendScript(widget.url)
      .then(() => {
        if (cancelled) {
          return;
        }
        const element = document.createElement(widget.tagName);
        element.setAttribute("data-widget-id", widget.id);
        if (widget.props) {
          Object.entries(widget.props).forEach(([key, value]) => {
            if (value !== undefined) {
              element.setAttribute(key, String(value));
            }
          });
        }
        const container = containerRef.current;
        if (!container) {
          return;
        }
        container.innerHTML = "";
        container.appendChild(element);
      })
      .catch((loadError) => {
        setError(loadError.message || "Failed to load microfrontend");
      });

    return () => {
      cancelled = true;
      const container = containerRef.current;
      if (container) {
        container.innerHTML = "";
      }
    };
  }, [widget]);

  if (error) {
    return createElement(
      "div",
      { className: "col-12 col-md-6 col-xl-4" },
      createElement(
        "div",
        { className: "card h-100 border-danger-subtle" },
        createElement(
          "div",
          { className: "card-header bg-danger text-white" },
          widget.title
        ),
        createElement(
          "div",
          { className: "card-body" },
          createElement("pre", { className: "mb-0 text-danger" }, error)
        )
      )
    );
  }

  return createElement(
    "div",
    { className: "col-12 col-md-6 col-xl-4" },
    createElement(
      "div",
      { className: "card h-100 shadow-sm border-0" },
      createElement(
        "div",
        { className: "card-header bg-body-secondary fw-semibold text-uppercase" },
        widget.title
      ),
      createElement(
        "div",
        { className: "card-body" },
        createElement("section", {
          ref: containerRef,
          className: "d-flex flex-column gap-2",
        })
      )
    )
  );
}

function useDashboardConfig(initialWidgets) {
  const [widgets, setWidgets] = useState(initialWidgets);

  useEffect(() => {
    async function fetchConfig() {
      try {
        const response = await fetch("/dashboard-config.json");
        if (!response.ok) {
          throw new Error(`Failed to fetch dashboard configuration: ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.widgets)) {
          throw new Error("Dashboard configuration must provide a widgets array");
        }
        setWidgets(data.widgets);
      } catch (error) {
        console.warn(`[dashboard] ${error.message}. Falling back to default widgets.`);
      }
    }

    fetchConfig();
  }, []);

  return widgets;
}

export function DashboardApp({ initialWidgets = DEFAULT_WIDGETS }) {
  const widgets = useDashboardConfig(initialWidgets);

  return createElement(
    "div",
    { className: "row g-4" },
    widgets.map((widget) =>
      createElement(WidgetContainer, {
        widget,
        key: widget.id,
      })
    )
  );
}

export function bootstrapDashboard(domNode, options = {}) {
  if (!domNode) {
    throw new Error("A DOM node is required to bootstrap the dashboard");
  }
  const root = createRoot(domNode);
  root.render(
    createElement(DashboardApp, {
      initialWidgets: options.widgets || DEFAULT_WIDGETS,
    })
  );
  return root;
}

if (typeof document !== "undefined") {
  const container = document.getElementById("microsim-dashboard");
  if (container) {
    bootstrapDashboard(container);
  }
}
