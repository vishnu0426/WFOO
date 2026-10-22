/**
 * Keeps one broken screen from blanking the whole app: shows what happened and lets the user carry on elsewhere.
 * Resets when `resetKey` (the current section) changes.
 */
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[ui] screen crashed:', error); }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-8">
        <div className="max-w-xl border border-[#C84A4A]/30 bg-[#FCEBEC] rounded-lg p-5 space-y-2">
          <h2 className="text-[16px] font-semibold text-[#C84A4A]">This screen hit a problem</h2>
          <p className="text-[13px] text-[#171717]">{this.state.error.message}</p>
          <p className="text-[12px] text-[#737373]">Other screens still work. Try another section, or reload the page.</p>
          <button onClick={() => this.setState({ error: null })} className="px-3 py-1.5 rounded border border-[#E5E5E0] bg-white text-[12px] font-semibold">Try again</button>
        </div>
      </div>
    );
  }
}
