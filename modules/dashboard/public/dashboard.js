import React, { useEffect, useState, useRef } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";

const { createElement } = React;

const DEFAULT_MODULE_WIDGETS = [
  {
    id: "queue-monitor",
    title: "Queue Monitor",
    url: "http://localhost:4200/microfrontends/queue-monitor.js",
    tagName: "queue-monitor",
    readmeModule: "queue",
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

const DEFAULT_DASHBOARD_CONFIG = {
  moduleWidgets: DEFAULT_MODULE_WIDGETS,
  architectureWidgets: [],
};

function normalizeDashboardConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const moduleWidgetsSource = Array.isArray(source.moduleWidgets)
    ? source.moduleWidgets
    : Array.isArray(source.widgets)
      ? source.widgets
      : DEFAULT_MODULE_WIDGETS;

  const architectureWidgetsSource = Array.isArray(source.architectureWidgets)
    ? source.architectureWidgets
    : Array.isArray(source.architecture)
      ? source.architecture
      : [];

  return {
    moduleWidgets:
      Array.isArray(moduleWidgetsSource) && moduleWidgetsSource.length > 0
        ? moduleWidgetsSource
        : DEFAULT_MODULE_WIDGETS,
    architectureWidgets: Array.isArray(architectureWidgetsSource)
      ? architectureWidgetsSource
      : [],
  };
}

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
  const [isReadmeOpen, setIsReadmeOpen] = useState(false);
  const [readmeContent, setReadmeContent] = useState("");
  const [isReadmeLoading, setIsReadmeLoading] = useState(false);
  const [readmeError, setReadmeError] = useState(null);
  const containerRef = useRef(null);
  const popupRef = useRef(null);
  const iconButtonRef = useRef(null);
  const readmeModule = widget.readmeModule || widget.module || widget.id;

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

  useEffect(() => {
    setIsReadmeOpen(false);
    setReadmeContent("");
    setReadmeError(null);
  }, [readmeModule]);

  useEffect(() => {
    if (!isReadmeOpen) {
      return undefined;
    }

    function handleGlobalClick(event) {
      const popupNode = popupRef.current;
      const buttonNode = iconButtonRef.current;
      const target = event.target;

      if (
        popupNode &&
        !popupNode.contains(target) &&
        buttonNode &&
        !buttonNode.contains(target)
      ) {
        setIsReadmeOpen(false);
      }
    }

    document.addEventListener("mousedown", handleGlobalClick);
    document.addEventListener("touchstart", handleGlobalClick);

    return () => {
      document.removeEventListener("mousedown", handleGlobalClick);
      document.removeEventListener("touchstart", handleGlobalClick);
    };
  }, [isReadmeOpen]);

  async function openReadme() {
    if (!readmeModule) {
      setReadmeError("No README configured for this widget");
      setIsReadmeOpen(true);
      return;
    }

    if (isReadmeLoading) {
      setIsReadmeOpen(true);
      return;
    }

    if (!readmeContent || readmeError) {
      try {
        setIsReadmeLoading(true);
        setReadmeError(null);
        const response = await fetch(`/readme/${encodeURIComponent(readmeModule)}`);
        if (!response.ok) {
          throw new Error(`No se pudo cargar el README (${response.status})`);
        }
        const text = await response.text();
        setReadmeContent(text);
        setReadmeError(null);
      } catch (readmeFetchError) {
        setReadmeError(readmeFetchError.message || "No se pudo cargar el README");
        setReadmeContent("");
      } finally {
        setIsReadmeLoading(false);
      }
    }

    setIsReadmeOpen(true);
  }

  function handleReadmeClick() {
    if (isReadmeOpen) {
      setIsReadmeOpen(false);
      return;
    }
    openReadme();
  }

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
      { className: "card h-100 shadow-sm border-0 position-relative" },
      createElement(
        "button",
        {
          type: "button",
          className:
            "btn btn-light btn-sm position-absolute top-0 start-0 m-2 rounded-circle shadow-sm border-0",
          style: {
            width: "2.25rem",
            height: "2.25rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
          },
          onClick: handleReadmeClick,
          ref: iconButtonRef,
          title: readmeModule
            ? `Ver README de ${readmeModule}`
            : "Ver README del módulo",
          "aria-label": readmeModule
            ? `Abrir README de ${readmeModule}`
            : "Abrir README del módulo",
        },
        "📄"
      ),
      isReadmeOpen &&
        createElement(
          "div",
          {
            ref: popupRef,
            className:
              "position-absolute bg-white border rounded shadow-sm p-3 small",
            style: {
              top: "3rem",
              left: "1rem",
              zIndex: 20,
              width: "min(22rem, calc(100% - 2rem))",
              maxHeight: "18rem",
              overflowY: "auto",
              boxShadow:
                "0 0.5rem 1rem rgba(33, 37, 41, 0.15), 0 0 0 1px rgba(33, 37, 41, 0.05)",
            },
          },
          createElement(
            "div",
            { className: "fw-semibold mb-2 text-secondary" },
            widget.title
          ),
          isReadmeLoading
            ? createElement(
                "p",
                { className: "mb-0 text-secondary" },
                "Cargando README..."
              )
            : readmeError
              ? createElement("p", { className: "mb-0 text-danger" }, readmeError)
              : createElement(
                  "pre",
                  {
                    className: "mb-0 text-body-secondary",
                    style: {
                      whiteSpace: "pre-wrap",
                      fontFamily: "var(--bs-font-monospace, 'SFMono-Regular', monospace)",
                    },
                  },
                  readmeContent
                )
        ),
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

function useDashboardConfig(initialConfig = DEFAULT_DASHBOARD_CONFIG) {
  const [config, setConfig] = useState(() => normalizeDashboardConfig(initialConfig));

  useEffect(() => {
    async function fetchConfig() {
      try {
        const response = await fetch("/dashboard-config.json");
        if (!response.ok) {
          throw new Error(`Failed to fetch dashboard configuration: ${response.status}`);
        }
        const data = await response.json();
        const normalized = normalizeDashboardConfig(data);
        setConfig(normalized);
      } catch (error) {
        console.warn(`[dashboard] ${error.message}. Falling back to default widgets.`);
      }
    }

    fetchConfig();
  }, []);

  return config;
}

function TabNavigation({ activeTab, onSelect, moduleCount, architectureCount }) {
  const tabs = [
    { id: "modules", label: "Módulos", count: moduleCount },
    { id: "architecture", label: "Arquitectura", count: architectureCount },
  ];

  return createElement(
    "ul",
    { className: "nav nav-pills mb-4 flex-wrap" },
    tabs.map((tab) =>
      createElement(
        "li",
        { className: "nav-item me-2 mb-2", key: tab.id },
        createElement(
          "button",
          {
            type: "button",
            className: `nav-link${activeTab === tab.id ? " active" : ""}`,
            onClick: () => onSelect(tab.id),
          },
          tab.label,
          createElement(
            "span",
            { className: "badge text-bg-secondary ms-2" },
            String(tab.count)
          )
        )
      )
    )
  );
}

export function DashboardApp({ initialConfig = DEFAULT_DASHBOARD_CONFIG }) {
  const [activeTab, setActiveTab] = useState("modules");
  const { moduleWidgets, architectureWidgets } = useDashboardConfig(initialConfig);

  useEffect(() => {
    if (
      activeTab === "modules" &&
      (!Array.isArray(moduleWidgets) || moduleWidgets.length === 0) &&
      Array.isArray(architectureWidgets) &&
      architectureWidgets.length > 0
    ) {
      setActiveTab("architecture");
    }
  }, [activeTab, moduleWidgets, architectureWidgets]);

  const tabs = {
    modules: Array.isArray(moduleWidgets) ? moduleWidgets : [],
    architecture: Array.isArray(architectureWidgets) ? architectureWidgets : [],
  };

  const activeWidgets = tabs[activeTab] || tabs.modules;
  const emptyMessages = {
    modules: "No hay microfrontends configurados para los módulos.",
    architecture: "No hay microfrontends configurados para la arquitectura desplegada.",
  };

  const hasWidgets = activeWidgets.length > 0;

  return createElement(
    React.Fragment,
    null,
    createElement(TabNavigation, {
      activeTab,
      onSelect: setActiveTab,
      moduleCount: tabs.modules.length,
      architectureCount: tabs.architecture.length,
    }),
    createElement(
      "div",
      { className: "row g-4" },
      hasWidgets
        ? activeWidgets.map((widget) =>
            createElement(WidgetContainer, {
              widget,
              key: widget.id,
            })
          )
        : createElement(
            "div",
            { className: "col-12" },
            createElement(
              "div",
              {
                className:
                  "alert alert-light border text-center text-secondary mb-0",
              },
              emptyMessages[activeTab] || "No hay microfrontends configurados."
            )
          )
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
      initialConfig: normalizeDashboardConfig({
        moduleWidgets: Array.isArray(options.moduleWidgets)
          ? options.moduleWidgets
          : Array.isArray(options.widgets)
            ? options.widgets
            : DEFAULT_MODULE_WIDGETS,
        architectureWidgets: Array.isArray(options.architectureWidgets)
          ? options.architectureWidgets
          : Array.isArray(options.architecture)
            ? options.architecture
            : [],
      }),
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
