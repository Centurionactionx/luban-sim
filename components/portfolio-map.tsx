"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { HoldingView } from "@/lib/contracts";
import {
  CASH_GROUP_LABEL,
  CASH_TILE_COLORS,
  DEFAULT_MAP_OPTIONS,
  MAP_LEGEND_STEPS,
  formatMapPercent,
  layoutPortfolioMap,
  mapTileColor,
  type MapColorBy,
  type MapSizeBy,
  type MapTile,
  type PortfolioMapOptions,
} from "@/lib/portfolio-map";

export interface PortfolioMapProps {
  holdings: HoldingView[];
  /** The team's cash, drawn as its own grey group when "Show cash" is on. */
  cashCents: number;
  /** Names the map for screen readers, e.g. "Northstar Capital portfolio map". */
  label: string;
  /** A tile was clicked (or chosen with Enter or Space). */
  onSelectSymbol: (symbol: string) => void;
}

const COLOR_OPTIONS: { value: MapColorBy; label: string }[] = [
  { value: "totalReturn", label: "Total return" },
  { value: "dayChange", label: "1-day %" },
];

const SIZE_OPTIONS: { value: MapSizeBy; label: string }[] = [
  { value: "marketValue", label: "Market value" },
  { value: "equal", label: "Equal" },
];

const COLOR_CAPTIONS: Record<MapColorBy, string> = {
  totalReturn: "Total return since purchase",
  dayChange: "Change since the previous close",
};

// The hover card's footprint, used to keep it inside the map.
const CARD_WIDTH_PX = 248;
const CARD_HEIGHT_PX = 196;
const CARD_OFFSET_PX = 8;

const currency = new Intl.NumberFormat("en-CA", {
  style: "currency",
  currency: "CAD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const number = new Intl.NumberFormat("en-CA");

function formatMoney(cents: number): string {
  return currency.format(cents / 100);
}

function formatSignedMoney(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${formatMoney(Math.abs(cents))}`;
}

function formatWeight(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

function changeClass(value: number): string {
  return value >= 0 ? "change change--positive" : "change change--negative";
}

/** One sentence a screen reader reads for a tile; the hover card in words. */
function tileDescription(tile: MapTile, cashWeight: number): string {
  if (!tile.holding) {
    return `Cash, ${formatMoney(tile.marketValueCents)}, ${formatWeight(cashWeight)} of portfolio`;
  }
  const { holding } = tile;
  return [
    `${holding.symbol}, ${holding.name}`,
    `${tile.sector} · ${tile.industry}`,
    `Market value ${formatMoney(holding.marketValueCents)}, ${formatWeight(holding.portfolioWeightPercent)} of portfolio`,
    `1-day ${formatMapPercent(holding.dayChangePercent)}`,
    `Total gain/loss ${formatSignedMoney(holding.gainLossCents)} (${formatMapPercent(holding.gainLossPercent)})`,
  ].join(". ");
}

/** Beside the tile when there is room, otherwise over it; always on the map. */
function cardPosition(
  tile: MapTile,
  width: number,
  height: number,
): { left: number; top: number } {
  const right = tile.x + tile.width + CARD_OFFSET_PX;
  const left =
    right + CARD_WIDTH_PX <= width
      ? right
      : tile.x - CARD_OFFSET_PX - CARD_WIDTH_PX >= 0
        ? tile.x - CARD_OFFSET_PX - CARD_WIDTH_PX
        : Math.max(0, Math.min(width - CARD_WIDTH_PX, tile.x + CARD_OFFSET_PX));
  const top = Math.max(0, Math.min(height - CARD_HEIGHT_PX, tile.y));
  return { left, top };
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = (width: number, height: number) =>
      setSize((current) =>
        current.width === Math.floor(width) && current.height === Math.floor(height)
          ? current
          : { width: Math.floor(width), height: Math.floor(height) },
      );
    const rect = element.getBoundingClientRect();
    measure(rect.width, rect.height);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) measure(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="portfolio-map__control">
      <span id={labelId} className="portfolio-map__control-label">
        {label}
      </span>
      <div className="portfolio-map__segments" role="group" aria-labelledby={labelId}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function MapHoverCard({
  tile,
  cashWeight,
  position,
}: {
  tile: MapTile;
  cashWeight: number;
  position: { left: number; top: number };
}) {
  const { holding } = tile;
  return (
    // The tile's aria-label already says all of this; the card is for eyes.
    <div className="portfolio-map__card" style={position} aria-hidden="true">
      {holding ? (
        <>
          <div className="portfolio-map__card-head">
            <strong>{holding.symbol}</strong>
            <span>{holding.name}</span>
            <small>
              {tile.sector} · {tile.industry}
            </small>
          </div>
          <dl>
            <div>
              <dt>Quantity</dt>
              <dd>{number.format(holding.quantity)}</dd>
            </div>
            <div>
              <dt>Market value</dt>
              <dd>{formatMoney(holding.marketValueCents)}</dd>
            </div>
            <div>
              <dt>Weight</dt>
              <dd>{formatWeight(holding.portfolioWeightPercent)}</dd>
            </div>
            <div>
              <dt>1-day</dt>
              <dd className={changeClass(holding.dayChangePercent)}>
                {formatMapPercent(holding.dayChangePercent)}
              </dd>
            </div>
            <div>
              <dt>Total gain/loss</dt>
              <dd className={changeClass(holding.gainLossCents)}>
                {formatSignedMoney(holding.gainLossCents)} (
                {formatMapPercent(holding.gainLossPercent)})
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <div className="portfolio-map__card-head">
            <strong>{CASH_GROUP_LABEL}</strong>
            <span>Uninvested Canadian dollars</span>
          </div>
          <dl>
            <div>
              <dt>Amount</dt>
              <dd>{formatMoney(tile.marketValueCents)}</dd>
            </div>
            <div>
              <dt>Weight</dt>
              <dd>{formatWeight(cashWeight)}</dd>
            </div>
          </dl>
        </>
      )}
    </div>
  );
}

/**
 * A Finviz-style map of one portfolio: sector and industry boxes holding a
 * tile per position, sized by CAD market value and coloured by return.
 * Tiles are plain buttons placed absolutely in pixels the layout module
 * computes for the measured box, so text stays crisp at any size.
 */
export function PortfolioMap({
  holdings,
  cashCents,
  label,
  onSelectSymbol,
}: PortfolioMapProps) {
  const [options, setOptions] = useState<PortfolioMapOptions>(DEFAULT_MAP_OPTIONS);
  const [listView, setListView] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [canvasRef, size] = useElementSize<HTMLDivElement>();
  const cashToggleId = useId();
  const captionId = useId();

  const layout = useMemo(
    () => layoutPortfolioMap(holdings, cashCents, options, size.width, size.height),
    [holdings, cashCents, options, size.width, size.height],
  );

  const holdingsValueCents = holdings.reduce(
    (sum, holding) => sum + holding.marketValueCents,
    0,
  );
  const totalValueCents = holdingsValueCents + Math.max(0, cashCents);
  const cashWeight = totalValueCents > 0 ? (Math.max(0, cashCents) / totalValueCents) * 100 : 0;
  const showCashRow = options.includeCash && cashCents > 0;
  const activeTile = layout.tiles.find((tile) => tile.key === activeKey) ?? null;
  const sortedHoldings = useMemo(
    () => [...holdings].sort((a, b) => b.marketValueCents - a.marketValueCents),
    [holdings],
  );

  const update = (patch: Partial<PortfolioMapOptions>) =>
    setOptions((current) => ({ ...current, ...patch }));

  const hasHoldings = holdings.length > 0;

  return (
    <div className="portfolio-map">
      <div className="portfolio-map__controls">
        <SegmentedControl
          label="Color by"
          options={COLOR_OPTIONS}
          value={options.colorBy}
          onChange={(colorBy) => update({ colorBy })}
        />
        <SegmentedControl
          label="Size by"
          options={SIZE_OPTIONS}
          value={options.sizeBy}
          onChange={(sizeBy) => update({ sizeBy })}
        />
        <label className="portfolio-map__toggle" htmlFor={cashToggleId}>
          <input
            id={cashToggleId}
            type="checkbox"
            checked={options.includeCash}
            onChange={(event) => update({ includeCash: event.target.checked })}
          />
          Show cash
        </label>
        <button
          type="button"
          className="portfolio-map__view-toggle"
          aria-pressed={listView}
          onClick={() => {
            setListView((current) => !current);
            setActiveKey(null);
          }}
        >
          View as list
        </button>
      </div>

      <div className="portfolio-map__stage">
        {!hasHoldings ? (
          <div className="portfolio-map__empty">
            <p>No holdings yet</p>
            <span>Buy a stock and it appears here as a tile.</span>
          </div>
        ) : listView ? (
          <div className="portfolio-map__list table-scroll">
            <table className="data-table portfolio-map__table">
              <caption className="sr-only">{label}, as a list</caption>
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col">Sector · industry</th>
                  <th scope="col">Market value</th>
                  <th scope="col">Weight</th>
                  <th scope="col">1-day</th>
                  <th scope="col">Total gain/loss</th>
                </tr>
              </thead>
              <tbody>
                {sortedHoldings.map((holding) => (
                  <tr key={holding.symbol}>
                    <th scope="row" data-label="Symbol">
                      <button
                        type="button"
                        className="symbol-button"
                        onClick={() => onSelectSymbol(holding.symbol)}
                      >
                        <strong>{holding.symbol}</strong>
                        <span>{holding.name}</span>
                      </button>
                    </th>
                    <td data-label="Sector · industry">
                      {holding.sector} · {holding.industry}
                    </td>
                    <td data-label="Market value">{formatMoney(holding.marketValueCents)}</td>
                    <td data-label="Weight">{formatWeight(holding.portfolioWeightPercent)}</td>
                    <td data-label="1-day">
                      <span className={changeClass(holding.dayChangePercent)}>
                        {formatMapPercent(holding.dayChangePercent)}
                      </span>
                    </td>
                    <td data-label="Total gain/loss">
                      <span className={changeClass(holding.gainLossCents)}>
                        {formatSignedMoney(holding.gainLossCents)} (
                        {formatMapPercent(holding.gainLossPercent)})
                      </span>
                    </td>
                  </tr>
                ))}
                {showCashRow ? (
                  <tr>
                    <th scope="row" data-label="Symbol">
                      {CASH_GROUP_LABEL}
                    </th>
                    <td data-label="Sector · industry">Cash (CAD)</td>
                    <td data-label="Market value">{formatMoney(cashCents)}</td>
                    <td data-label="Weight">{formatWeight(cashWeight)}</td>
                    <td data-label="1-day">—</td>
                    <td data-label="Total gain/loss">—</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Stays mounted under the list so the resize observer keeps watching it. */}
        <div
          ref={canvasRef}
          className="portfolio-map__canvas"
          role="group"
          aria-label={label}
          aria-describedby={captionId}
          hidden={!hasHoldings || listView}
          onMouseLeave={() => setActiveKey(null)}
        >
          {layout.tiles
            .filter((tile) => tile.isCash)
            .map((tile) => {
              const labelRect = tile.labelRect ?? tile;
              return (
                <div
                  key={tile.key}
                  className="portfolio-map__tile portfolio-map__tile--cash"
                  style={{
                    left: tile.x,
                    top: tile.y,
                    width: tile.width,
                    height: tile.height,
                    background: tile.background,
                    color: tile.color,
                  }}
                  role="img"
                  aria-label={tileDescription(tile, cashWeight)}
                  onMouseEnter={() => setActiveKey(tile.key)}
                >
                  {tile.labelSize > 0 ? (
                    <span
                      className="portfolio-map__cash-label"
                      style={{
                        left: labelRect.x - tile.x,
                        top: labelRect.y - tile.y,
                        width: labelRect.width,
                        height: labelRect.height,
                        fontSize: tile.labelSize,
                      }}
                    >
                      <strong>{tile.symbol}</strong>
                      {tile.showDetail ? <span>{tile.detail}</span> : null}
                    </span>
                  ) : null}
                </div>
              );
            })}
          <div
            className="portfolio-map__holdings-area"
            style={{
              left: layout.holdingsArea.x,
              top: layout.holdingsArea.y,
              width: layout.holdingsArea.width,
              height: layout.holdingsArea.height,
            }}
            aria-hidden="true"
            onMouseEnter={() => setActiveKey(null)}
          />
          {layout.sectors.map((sector) => (
            <div
              key={sector.key}
              className={`portfolio-map__sector${sector.isCash ? " portfolio-map__sector--cash" : ""}`}
              style={{
                left: sector.x,
                top: sector.y,
                width: sector.width,
                height: sector.height,
              }}
              aria-hidden="true"
            >
              {sector.headerHeight > 0 ? (
                <span
                  style={{
                    height: sector.headerHeight,
                    lineHeight: `${sector.headerHeight}px`,
                  }}
                >
                  {sector.label}
                </span>
              ) : null}
            </div>
          ))}
          {layout.industries.map((industry) =>
            industry.headerHeight > 0 ? (
              <div
                key={industry.key}
                className="portfolio-map__industry"
                style={{
                  left: industry.x,
                  top: industry.y,
                  width: industry.width,
                  height: industry.headerHeight,
                  lineHeight: `${industry.headerHeight}px`,
                }}
                aria-hidden="true"
              >
                {industry.label}
              </div>
            ) : null,
          )}
          {layout.tiles.filter((tile) => !tile.isCash).map((tile) => {
            const style = {
              left: tile.x,
              top: tile.y,
              width: tile.width,
              height: tile.height,
              background: tile.background,
              color: tile.color,
              fontSize: tile.labelSize || undefined,
            };
            const content =
              tile.labelSize > 0 ? (
                <>
                  <strong>{tile.symbol}</strong>
                  {tile.showDetail ? <span>{tile.detail}</span> : null}
                </>
              ) : null;
            const hoverProps = {
              onMouseEnter: () => setActiveKey(tile.key),
              onFocus: () => setActiveKey(tile.key),
              onBlur: () => setActiveKey((current) => (current === tile.key ? null : current)),
            };
            return (
              <button
                key={tile.key}
                type="button"
                className="portfolio-map__tile"
                style={style}
                aria-label={tileDescription(tile, cashWeight)}
                data-symbol={tile.symbol}
                onClick={() => onSelectSymbol(tile.symbol)}
                {...hoverProps}
              >
                {content}
              </button>
            );
          })}
          {activeTile ? (
            <MapHoverCard
              tile={activeTile}
              cashWeight={cashWeight}
              position={cardPosition(
                activeTile.labelRect ? { ...activeTile, ...activeTile.labelRect } : activeTile,
                layout.width,
                layout.height,
              )}
            />
          ) : null}
        </div>
      </div>

      <div className="portfolio-map__legend">
        <span id={captionId}>
          {COLOR_CAPTIONS[options.colorBy]} · area by{" "}
          {options.sizeBy === "equal" ? "equal weight" : "CAD market value"}
        </span>
        <ol aria-label={`${COLOR_CAPTIONS[options.colorBy]} colour scale`}>
          {MAP_LEGEND_STEPS[options.colorBy].map((step) => (
            <li key={step} style={mapTileColor(step, options.colorBy)}>
              {step === 0 ? "0%" : `${step > 0 ? "+" : "−"}${Math.abs(step)}%`}
            </li>
          ))}
          {showCashRow ? (
            <li className="portfolio-map__legend-cash" style={CASH_TILE_COLORS}>
              Cash
            </li>
          ) : null}
        </ol>
      </div>
    </div>
  );
}

