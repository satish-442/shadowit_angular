import {
  AfterViewInit, Component, Input, OnChanges,
  OnDestroy, SimpleChanges, ViewChild, ElementRef
} from '@angular/core';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import { ChartDataResponse } from '../../../core/services/api.service';

Chart.register(...registerables);

@Component({
  selector: 'app-charts',
  standalone: false,
  templateUrl: './charts.component.html',
})
export class ChartsComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() chartData: ChartDataResponse = {} as ChartDataResponse;
  @Input() visible = true;

  @ViewChild('statusCanvas') statusCanvas?: ElementRef<HTMLCanvasElement>;
  @ViewChild('methodCanvas') methodCanvas?: ElementRef<HTMLCanvasElement>;

  private statusChart?: Chart;
  private methodChart?: Chart;
  /** Guard flag — prevents applyChartData() from calling initializeCharts() recursively */
  private chartsInitialized = false;
  private initPending = false;

  ngAfterViewInit(): void {
    this.initializeCharts();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['chartData'] && !changes['chartData'].firstChange) {
      if (this.chartsInitialized) {
        this.applyChartData();
      }
      // If charts not ready yet, data will be applied inside initializeCharts()
    }

    if (changes['visible'] && this.visible && !this.chartsInitialized) {
      // Re-init when tab becomes visible (e.g. switching back to Dashboard)
      setTimeout(() => this.initializeCharts(), 50);
    }
  }

  ngOnDestroy(): void {
    this.statusChart?.destroy();
    this.methodChart?.destroy();
  }

  private initializeCharts(): void {
    if (!this.statusCanvas?.nativeElement || !this.methodCanvas?.nativeElement) return;
    if (this.initPending) return;

    this.initPending = true;

    setTimeout(() => {
      this.initPending = false;
      this.statusChart?.destroy();
      this.methodChart?.destroy();

      const statusConfig: ChartConfiguration<'doughnut'> = {
        type: 'doughnut',
        data: {
          labels: ['Compliant', 'Shadow IT', 'Review'],
          datasets: [{ data: [0, 0, 0], backgroundColor: ['#86efac', '#fca5a5', '#fde047'], borderColor: '#ffffff', borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
      };

      const methodConfig: ChartConfiguration<'doughnut'> = {
        type: 'doughnut',
        data: {
          labels: ['Exact', 'AI', 'Manual'],
          datasets: [{ data: [0, 0, 0], backgroundColor: ['#10b981', '#a855f7', '#3b82f6'], borderColor: '#ffffff', borderWidth: 2 }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
      };

      this.statusChart = new Chart(this.statusCanvas!.nativeElement, statusConfig);
      this.methodChart = new Chart(this.methodCanvas!.nativeElement, methodConfig);
      this.chartsInitialized = true;

      if (this.chartData && Object.keys(this.chartData).length > 0) {
        this.applyChartData();
      }
    }, 0);
  }

  private applyChartData(): void {
    // Guard: do NOT call initializeCharts() here — that's the recursion bug.
    // If charts aren't ready, ngOnChanges will retry once visible/initialized.
    if (!this.statusChart || !this.methodChart) return;

    this.statusChart.data.datasets[0].data = [
      this.toNumber(this.chartData.compliant),
      this.toNumber(this.chartData.shadowit),
      this.toNumber(this.chartData.review),
    ];
    this.statusChart.update();

    const labels = this.chartData.method_labels || ['Exact', 'AI', 'Manual'];
    this.methodChart.data.labels = labels;
    this.methodChart.data.datasets[0].data = labels.map(label => {
      const l = label.toUpperCase();
      if (l === 'EXACT') return this.toNumber(this.chartData.exact_count);
      if (l === 'AI' || l === 'AI-CLEANUP') return this.toNumber(this.chartData.ai_count);
      return 0;
    });
    this.methodChart.update();
  }

  private toNumber(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }
}
