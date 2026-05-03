from prometheus_client import Counter, Histogram, generate_latest, CONTENT_TYPE_LATEST

REQUESTS_TOTAL = Counter(
    "legal_graph_requests_total",
    "Total HTTP requests",
    labelnames=("method", "path", "status"),
)

REQUEST_DURATION_SECONDS = Histogram(
    "legal_graph_request_duration_seconds",
    "HTTP request duration",
    labelnames=("method", "path"),
)

def render_metrics() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
