import React, { useEffect, useState, useRef, useMemo } from "https://esm.sh/react@18";
import { createRoot } from "https://esm.sh/react-dom@18/client";
import { marked } from "https://esm.sh/marked@12";
import ReactFlow, {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  useEdgesState,
  useNodesState,
} from "https://esm.sh/reactflow@11?bundle&deps=react@18,react-dom@18";

marked.setOptions({
  breaks: true,
  gfm: true,
  mangle: false,
  headerIds: false,
});

const { createElement } = React;

const REACT_FLOW_STYLESHEET_URL = "https://esm.sh/reactflow@11/dist/style.css";
const ARCHITECTURE_STYLES_ID = "architecture-design-styles";
const ARCHITECTURE_DESIGN_HEIGHT = 360;

const ARCHITECTURE_STYLES = `
.architecture-design-wrapper {
  margin-bottom: 1.5rem;
}

.architecture-design-card {
  overflow: hidden;
}

.architecture-design-card .card-header {
  background-color: var(--bs-body-bg, #ffffff);
  border-bottom: 1px solid rgba(0, 0, 0, 0.08);
  font-weight: 600;
}

.architecture-design-diagram {
  height: ${ARCHITECTURE_DESIGN_HEIGHT}px;
}

.react-flow__node-domainNode {
  padding: 0;
  border: none;
  box-shadow: none;
  background: transparent;
}

.react-flow__edges,
.react-flow__edge {
  z-index: 10;
}

.domain-node {
  background-color: var(--bs-tertiary-bg, #f8f9fa);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  padding: 16px;
  color: var(--bs-body-color, #212529);
  font-family: inherit;
  position: relative;
  cursor: grab;
}

.react-flow__node.dragging .domain-node {
  cursor: grabbing;
}

.domain-node__title {
  font-weight: 600;
  font-size: 1rem;
  margin-bottom: 8px;
}

.domain-node__services {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.domain-node__service {
  display: flex;
  flex-direction: column;
  background-color: var(--bs-body-bg, #ffffff);
  border-radius: 8px;
  padding: 8px 10px;
  border: 1px solid rgba(0, 0, 0, 0.05);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  position: relative;
}

.domain-node__service-name {
  font-weight: 500;
}

.domain-node__service-type {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--bs-secondary-color, #6c757d);
  margin-top: 4px;
}

.domain-node__empty {
  font-size: 0.875rem;
  color: var(--bs-secondary-color, #6c757d);
}

.react-flow__controls {
  box-shadow: none;
  border-radius: 8px;
}

.react-flow__attribution {
  display: none;
}
`;

function ensureStylesheet(href) {
  if (typeof document === "undefined") {
    return;
  }
  const existing = document.querySelector(`link[data-href='${href}']`);
  if (existing) {
    return;
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.href = href;
  document.head.appendChild(link);
}

function ensureArchitectureStyles() {
  if (typeof document === "undefined") {
    return;
  }
  if (document.getElementById(ARCHITECTURE_STYLES_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = ARCHITECTURE_STYLES_ID;
  style.textContent = ARCHITECTURE_STYLES;
  document.head.appendChild(style);
}

if (typeof document !== "undefined") {
  ensureStylesheet(REACT_FLOW_STYLESHEET_URL);
  ensureArchitectureStyles();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasArchitectureDesign(design) {
  return isPlainObject(design) && Object.keys(design).length > 0;
}

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
  architectureDesign: null,
};

function normalizeArchitectureDesign(design) {
  if (!hasArchitectureDesign(design)) {
    return null;
  }
  return design;
}

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

  let architectureDesign = normalizeArchitectureDesign(source.architectureDesign);
  if (!architectureDesign && source.design) {
    architectureDesign = normalizeArchitectureDesign(source.design);
  }

  return {
    moduleWidgets:
      Array.isArray(moduleWidgetsSource) && moduleWidgetsSource.length > 0
        ? moduleWidgetsSource
        : DEFAULT_MODULE_WIDGETS,
    architectureWidgets: Array.isArray(architectureWidgetsSource)
      ? architectureWidgetsSource
      : [],
    architectureDesign,
  };
}

const DOMAIN_COLUMN_WIDTH = 320;
const DOMAIN_ROW_HEIGHT = 230;

function createArchitectureGraph(design) {
  if (!hasArchitectureDesign(design)) {
    return { nodes: [], edges: [] };
  }

  const domainEntries = Object.entries(design);
  if (domainEntries.length === 0) {
    return { nodes: [], edges: [] };
  }

  const columnCount = Math.max(1, Math.ceil(Math.sqrt(domainEntries.length)));
  const nodes = [];
  const edges = [];
  let edgeIdCounter = 0;

  domainEntries.forEach(([domainKey, domainValue], index) => {
    const column = index % columnCount;
    const row = Math.floor(index / columnCount);
    const services = Array.isArray(domainValue?.services)
      ? domainValue.services
      : [];

    nodes.push({
      id: domainKey,
      type: "domainNode",
      position: {
        x: column * DOMAIN_COLUMN_WIDTH,
        y: row * DOMAIN_ROW_HEIGHT,
      },
      data: {
        label: domainValue?.name || domainKey,
        services,
        domainKey,
      },
      selectable: false,
    });

    services.forEach((service, serviceIndex) => {
      if (
        !service ||
        typeof service !== "object" ||
        service.type !== "integration" ||
        !Array.isArray(service.integrates)
      ) {
        return;
      }
      service.integrates.forEach((targetKey) => {
        if (!design[targetKey]) {
          return;
        }
        const edgeId = `${domainKey}-${targetKey}-${serviceIndex}-${edgeIdCounter}`;
        edgeIdCounter += 1;
        edges.push({
          id: edgeId,
          source: domainKey,
          target: targetKey,
          label: service.name || "Integración",
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          animated: false,
          labelBgPadding: [6, 4],
          labelBgBorderRadius: 4,
          labelStyle: { fontSize: 12 },
          sourceHandle: `integration-${domainKey}-${serviceIndex}`,
          targetHandle: "domain-target",
        });
      });
    });
  });

  return { nodes, edges };
}

function DomainNode({ data }) {
  const label = data?.label || "Dominio";
  const services = Array.isArray(data?.services) ? data.services : [];
  const domainKey = data?.domainKey || "domain";

  return createElement(
    "div",
    { className: "domain-node" },
    createElement(Handle, {
      type: "target",
      position: Position.Left,
      id: "domain-target",
      style: {
        top: "50%",
        transform: "translateY(-50%)",
        left: -8,
        width: 12,
        height: 12,
        background: "var(--bs-primary, #0d6efd)",
      },
    }),
    createElement("div", { className: "domain-node__title" }, label),
    services.length > 0
      ? createElement(
          "ul",
          { className: "domain-node__services" },
          services.map((service, index) =>
            createElement(
              "li",
              {
                key: `${service?.name || "service"}-${index}`,
                className: "domain-node__service",
              },
              service?.type === "integration"
                ? createElement(Handle, {
                    key: `integration-handle-${index}`,
                    type: "source",
                    position: Position.Right,
                    id: `integration-${domainKey}-${index}`,
                    style: {
                      top: "50%",
                      transform: "translateY(-50%)",
                      right: -8,
                      width: 12,
                      height: 12,
                      background: "var(--bs-primary, #0d6efd)",
                    },
                  })
                : null,
              createElement(
                "span",
                { className: "domain-node__service-name" },
                service?.name || `Servicio ${index + 1}`,
              ),
              service?.type
                ? createElement(
                    "span",
                    { className: "domain-node__service-type" },
                    service.type,
                  )
                : null,
            ),
          ),
        )
      : createElement(
          "div",
          { className: "domain-node__empty" },
          "Sin servicios documentados",
        ),
  );
}

function ArchitectureDesignDiagram({ design }) {
  const graph = useMemo(() => createArchitectureGraph(design), [design]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(graph.edges);
  const nodeTypes = useMemo(() => ({ domainNode: DomainNode }), []);

  useEffect(() => {
    setNodes(graph.nodes);
    setEdges(graph.edges);
  }, [graph, setNodes, setEdges]);

  if (graph.nodes.length === 0) {
    return createElement(
      "div",
      {
        className: "alert alert-light border text-center text-secondary mb-0",
      },
      "No hay un diseño de arquitectura disponible.",
    );
  }

  return createElement(
    "div",
    { className: "architecture-design-diagram" },
    createElement(
      ReactFlow,
      {
        nodes,
        edges,
        nodeTypes,
        fitView: true,
        fitViewOptions: { padding: 0.2, includeHiddenNodes: true },
        nodesConnectable: false,
        nodesDraggable: true,
        elementsSelectable: false,
        zoomOnScroll: false,
        zoomOnPinch: false,
        zoomOnDoubleClick: false,
        panOnDrag: true,
        panOnScroll: true,
        proOptions: { hideAttribution: true },
        onNodesChange,
        onEdgesChange,
      },
      createElement(Background, { gap: 20, size: 1 }),
      createElement(Controls, { showInteractive: false }),
    ),
  );
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

  const readmeHtml = useMemo(() => {
    if (!readmeContent) {
      return "";
    }
    try {
      return marked.parse(readmeContent);
    } catch (parseError) {
      console.warn(
        `[dashboard] No se pudo renderizar el README de ${readmeModule}:`,
        parseError
      );
      return "";
    }
  }, [readmeContent, readmeModule]);

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
            "btn btn-light btn-sm position-absolute top-0 end-0 m-2 rounded-circle shadow-sm border-0",
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
              left: "auto",
              right: "1rem",
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
              : readmeHtml
                ? createElement("div", {
                    className: "mb-0 text-body-secondary d-block",
                    style: { whiteSpace: "normal" },
                    dangerouslySetInnerHTML: { __html: readmeHtml },
                  })
                : createElement(
                    "pre",
                    {
                      className: "mb-0 text-body-secondary",
                      style: {
                        whiteSpace: "pre-wrap",
                        fontFamily:
                          "var(--bs-font-monospace, 'SFMono-Regular', monospace)",
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
  const { moduleWidgets, architectureWidgets, architectureDesign } =
    useDashboardConfig(initialConfig);

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
  const showArchitectureDesign =
    activeTab === "architecture" && hasArchitectureDesign(architectureDesign);

  return createElement(
    React.Fragment,
    null,
    createElement(TabNavigation, {
      activeTab,
      onSelect: setActiveTab,
      moduleCount: tabs.modules.length,
      architectureCount: tabs.architecture.length,
    }),
    showArchitectureDesign
      ? createElement(
          "div",
          { className: "architecture-design-wrapper" },
          createElement(
            "div",
            { className: "card architecture-design-card" },
            createElement(
              "div",
              { className: "card-header" },
              "Diseño de la arquitectura",
            ),
            createElement(
              "div",
              { className: "card-body" },
              createElement(ArchitectureDesignDiagram, {
                design: architectureDesign,
              }),
            ),
          ),
        )
      : null,
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
        architectureDesign: options.architectureDesign,
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
