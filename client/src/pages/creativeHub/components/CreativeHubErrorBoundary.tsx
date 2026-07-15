import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CreativeHubErrorBoundaryProps {
  children: ReactNode;
  title?: string;
}

interface CreativeHubErrorBoundaryState {
  error: Error | null;
}

/**
 * 隔离创作中枢 runtime/provider 渲染异常，避免整页 #root 白屏。
 */
export default class CreativeHubErrorBoundary extends Component<
  CreativeHubErrorBoundaryProps,
  CreativeHubErrorBoundaryState
> {
  state: CreativeHubErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): CreativeHubErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[creative-hub] render error", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <Card className="flex h-full min-h-0 flex-col border-rose-200 bg-rose-50/40">
        <CardHeader>
          <CardTitle className="text-base text-rose-900">
            {this.props.title ?? "创作中枢暂时无法渲染"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-rose-900/90">
          <p>对话区发生客户端异常，已拦截以避免整站白屏。可重试渲染，或刷新页面。</p>
          <pre className="max-h-40 overflow-auto rounded-xl bg-white/80 p-3 text-xs text-rose-800 ring-1 ring-rose-200">
            {error.message || String(error)}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={this.handleRetry}>
              重试渲染
            </Button>
            <Button type="button" variant="outline" onClick={this.handleReload}>
              刷新页面
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }
}
