import { useMemo, useState, type CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import type { FinancialTableProjection } from "../../model-db/queries";
import type { Metric, Observation, SourceLocator } from "../../model-db/types";

type Props = {
  projection: FinancialTableProjection;
  selectedTargetId: string | null;
  onSelectMetric: (metricId: string) => void;
  onSelectObservation: (observationId: string) => void;
};

function formatValue(value: Observation["value"], metric: Metric): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value;
  if (metric.dataType === "percentage") {
    return new Intl.NumberFormat("en-US", {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: metric.dataType === "count" ? 0 : 1,
    maximumFractionDigits: metric.dataType === "count" ? 0 : 1,
  }).format(Math.abs(value));
  return value < 0 ? `(${formatted})` : formatted;
}

function valueTypeLabel(valueType: Observation["valueType"]): string {
  const labels: Record<Observation["valueType"], string> = {
    reported: "Reported",
    assumption: "Assumption",
    derived: "Derived",
    external_estimate: "External estimate",
  };
  return labels[valueType];
}

function sourceLocation(locator: SourceLocator | undefined): string | null {
  if (!locator) return null;
  if (locator.sheet && locator.range) return `${locator.sheet}!${locator.range}`;
  if (locator.sheet && locator.cell) return `${locator.sheet}!${locator.cell}`;
  return locator.sheet ?? null;
}

export function FinancialTable({
  projection,
  selectedTargetId,
  onSelectMetric,
  onSelectObservation,
}: Props) {
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const sections = useMemo(
    () =>
      projection.sections
        .map((section) => ({
          ...section,
          rows: normalizedSearch
            ? section.rows.filter((row) =>
                [row.metric.name, row.metric.id, ...(row.metric.tags ?? [])]
                  .join(" ")
                  .toLocaleLowerCase()
                  .includes(normalizedSearch),
              )
            : section.rows,
        }))
        .filter((section) => section.rows.length > 0),
    [normalizedSearch, projection.sections],
  );
  const shownRows = sections.flatMap((section) => section.rows);

  const periodModes = projection.periods.map((period) => {
    const observation = projection.rows
      .map((row) => row.observations[period.id])
      .find(Boolean);
    return observation?.actuality ?? "estimate";
  });

  return (
    <section className="table-view" data-testid="financial-table-view">
      <div className="table-commandbar">
        <label className="search-field">
          <Icon name="search" size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a metric"
            aria-label="Search metrics"
          />
          {search && (
            <button onClick={() => setSearch("")} aria-label="Clear search">
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <div className="table-context">
          <span>{shownRows.length} metrics</span>
          <span>{projection.periods.length} periods</span>
          <span>{projection.presentation ? "Extracted layout" : "Source-order fallback"}</span>
        </div>
      </div>

      <div className="financial-table-wrap">
        <table className="financial-table">
          <thead>
            <tr>
              <th className="metric-column">
                <span>Metric</span>
                <small>{projection.model.baseCurrency} millions unless noted</small>
              </th>
              {projection.periods.map((period, index) => {
                const mode = periodModes[index];
                const boundary = index > 0 && periodModes[index - 1] !== mode;
                return (
                  <th
                    key={period.id}
                    className={`${mode} ${boundary ? "forecast-boundary" : ""}`}
                  >
                    <span>{period.label}</span>
                    <small>{mode === "actual" ? "Actual" : "Estimate"}</small>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sections.map((section) => (
              <TableSection
                key={section.id}
                section={section}
                periods={projection.periods}
                periodModes={periodModes}
                selectedTargetId={selectedTargetId}
                onSelectMetric={onSelectMetric}
                onSelectObservation={onSelectObservation}
              />
            ))}
          </tbody>
        </table>
        {shownRows.length === 0 && (
          <div className="empty-search">
            <Icon name="search" size={20} />
            No metric matches “{search}”.
          </div>
        )}
      </div>

      <footer className="table-footnote">
        Select a value to inspect its properties, workbook source, and formula inputs.
      </footer>
    </section>
  );
}

type TableSectionProps = {
  section: FinancialTableProjection["sections"][number];
  periods: FinancialTableProjection["periods"];
  periodModes: string[];
  selectedTargetId: string | null;
  onSelectMetric: (metricId: string) => void;
  onSelectObservation: (observationId: string) => void;
};

function TableSection({
  section,
  periods,
  periodModes,
  selectedTargetId,
  onSelectMetric,
  onSelectObservation,
}: TableSectionProps) {
  const location = sourceLocation(section.sourceLocator);
  return (
    <>
      <tr className="table-section-row">
        <th colSpan={periods.length + 1}>
          <span>{section.title}</span>
          {location && <small>{location}</small>}
        </th>
      </tr>
      {section.rows.map((row) => {
        const isDerived = Object.values(row.observations).some(
          (observation) => observation?.valueType === "derived",
        );
        return (
          <tr key={row.metric.id} className={row.depth === 0 ? "root-metric-row" : "child-metric-row"}>
            <th scope="row" className="metric-column">
              <button
                className={`metric-label-button ${selectedTargetId === row.metric.id ? "selected" : ""}`}
                onClick={() => onSelectMetric(row.metric.id)}
                style={{ "--metric-depth": row.depth } as CSSProperties}
                aria-pressed={selectedTargetId === row.metric.id}
              >
                <span className="hierarchy-guide" />
                <span className="metric-label-copy">
                  <strong>{row.metric.name}</strong>
                  <small>{row.metric.unit ?? row.metric.dataType}</small>
                </span>
                <span className="metric-row-signals">
                  {isDerived && <span className="formula-badge">fx</span>}
                  {row.unresolvedItems.length > 0 && (
                    <span
                      className="row-warning"
                      title={row.unresolvedItems.map((item) => item.description).join("; ")}
                      aria-label={`${row.unresolvedItems.length} open extraction issue${row.unresolvedItems.length === 1 ? "" : "s"}`}
                    >
                      <Icon name="warning" size={12} /> review
                    </span>
                  )}
                </span>
              </button>
            </th>
            {periods.map((period, index) => {
              const observation = row.observations[period.id];
              const boundary = index > 0 && periodModes[index - 1] !== periodModes[index];
              return (
                <td
                  key={period.id}
                  className={`${periodModes[index]} ${boundary ? "forecast-boundary" : ""}`}
                >
                  {observation ? (
                    <button
                      className={`value-button ${observation.valueType} ${selectedTargetId === observation.id ? "selected" : ""}`}
                      onClick={() => onSelectObservation(observation.id)}
                      title={`${valueTypeLabel(observation.valueType)} · ${observation.id}`}
                      aria-pressed={selectedTargetId === observation.id}
                    >
                      <span>{formatValue(observation.value, row.metric)}</span>
                      {observation.valueType === "derived" && <i>fx</i>}
                    </button>
                  ) : (
                    <span className="empty-value">—</span>
                  )}
                </td>
              );
            })}
          </tr>
        );
      })}
    </>
  );
}
