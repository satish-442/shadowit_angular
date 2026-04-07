import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { FormsModule } from '@angular/forms';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { httpErrorInterceptor } from './core/interceptors/http-error.interceptor';

import { DashboardComponent } from './features/dashboard/dashboard.component';
import { KpiCardsComponent } from './features/dashboard/kpi-cards/kpi-cards.component';
import { ChartsComponent } from './features/dashboard/charts/charts.component';
import { ResultsTableComponent } from './features/dashboard/results-table/results-table.component';

@NgModule({
  declarations: [
    AppComponent,
    DashboardComponent,
    KpiCardsComponent,
    ChartsComponent,
    ResultsTableComponent,
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    FormsModule,
  ],
  providers: [
    provideHttpClient(withInterceptors([httpErrorInterceptor])),
  ],
  bootstrap: [AppComponent],
})
export class AppModule {}
