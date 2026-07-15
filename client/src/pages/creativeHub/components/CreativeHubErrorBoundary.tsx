import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface CreativeHubErrorBoundaryProps {
  children: ReactNode;
  title?: string;
}

interface CreativeHubErrorBoundaryState {
  error: Error | null;
  retryKey: number;
}

/**
 * 隔离创作中枢整页/runtime 渲染异常，避免整站 #root 白屏。
 * 重试通过递增 key 强制 remount 子树，避免同 props 立刻再炸。
 */
export default class CreativeHubErrorBoundary extends Component<
  CreativeHubErrorBoundaryProps,
  CreativeHubErrorBoundaryState
> {
  state: CreativeHubErrorBoundaryState = {
    error: null,
    retryKey: 0,
  };

  static getDerivedStateFromError(error: Error): Partial<CreativeHubErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[creative-hub] render error", error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState((prev) => ({
      error: null,
      retryKey: prev.retryKey + 1,
    }));
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    const { error, retryKey } = this.state;
    if (error) {
      return (
        <Card className="flex h-full min-h-0 flex-col border-rose-200 bg-rose-50/40">
          <CardHeader>
            <CardTitle className="text-base text-rose-900">
              {this.props.title ?? "创作中枢暂时无法渲染"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-rose-900/90">
            <p>
              创作中枢发生客户端异常，已拦截以避免整站白屏。可重试（会重新挂载本区），
              若仍失败请刷新页面。
            </p>
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

    return (
      <div key={retryKey} className="contents">
        {this.props.children}
      </div>
    );
  }
}
