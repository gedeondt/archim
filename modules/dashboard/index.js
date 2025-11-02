import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

const DEFAULT_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
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
  const containerRef = React.useRef(null);

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
    return (
      <div className="widget widget-error">
        <header>{widget.title}</header>
        <pre>{error}</pre>
      </div>
    );
  }

  return (
    <div className="widget">
      <header>{widget.title}</header>
      <section ref={containerRef} className="widget-body" />
    </div>
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
  const gridTemplate = useMemo(() => `repeat(${Math.max(1, widgets.length)}, 1fr)`, [widgets.length]);

  return (
    <div className="dashboard" style={{ display: "grid", gridTemplateColumns: gridTemplate, gap: "1rem" }}>
      {widgets.map((widget) => (
        <WidgetContainer key={widget.id} widget={widget} />
      ))}
    </div>
  );
}

export function bootstrapDashboard(domNode, options = {}) {
  if (!domNode) {
    throw new Error("A DOM node is required to bootstrap the dashboard");
  }
  const root = createRoot(domNode);
  root.render(<DashboardApp initialWidgets={options.widgets || DEFAULT_WIDGETS} />);
  return root;
}

if (typeof document !== "undefined") {
  const container = document.getElementById("microsim-dashboard");
  if (container) {
    bootstrapDashboard(container);
  }
}
