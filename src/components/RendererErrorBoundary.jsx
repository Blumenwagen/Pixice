import { Component } from "react";

export class RendererErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Pixice renderer recovered from an uncaught view error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="renderer-recovery" role="alert">
        <div className="renderer-recovery-card">
          <span className="renderer-recovery-kicker">View recovery</span>
          <h1>Pixice hit a display error</h1>
          <p>Your projects and task history are safe. Reload the interface to try the view again.</p>
          <pre>{this.state.error?.message || "Unknown renderer error"}</pre>
          <button type="button" onClick={() => window.location.reload()}>Reload interface</button>
        </div>
      </main>
    );
  }
}
