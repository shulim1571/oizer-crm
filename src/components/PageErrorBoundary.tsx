import { Component, type ReactNode } from 'react';

// One page failing shows a message there; the sidebar and every other page keep working.
export default class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="view">
        <div className="error">
          This page hit a problem and couldn’t show. Other pages still work.
          <div className="muted small">{this.state.error.message}</div>
        </div>
        <div><button className="btn" onClick={() => this.setState({ error: null })}>Try again</button></div>
      </section>
    );
  }
}
