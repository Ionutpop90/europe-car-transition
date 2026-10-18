-- =====================================================================
-- 01 · STAGING — typed views over the raw extracts + the model assumptions
-- =====================================================================

CREATE OR REPLACE MACRO geo_clean(g) AS CASE g WHEN 'EU27_2020' THEN 'EU27' ELSE g END;

-- Assumptions for the petrol-vs-electric comparison (central value + plausible range).
-- Every number here is a modelling choice and is shown in the report's methodology.
CREATE OR REPLACE TABLE dim_assumption AS
SELECT * FROM (VALUES
  ('petrol_l_100km',       6.5,   5.5,   7.5,  'L/100 km',        'Real-world consumption, compact petrol car (WLTP + typical real-world gap)'),
  ('diesel_l_100km',       5.5,   4.7,   6.3,  'L/100 km',        'Real-world consumption, compact diesel car'),
  ('bev_kwh_100km',       18.0,  15.0,  21.0,  'kWh/100 km',      'Real-world consumption of a compact BEV at the plug, incl. charging losses'),
  ('petrol_kgco2_l',       2.80,  2.70,  2.90, 'kg CO2e/L',       'Well-to-wheel petrol: 2.31 combustion + ~0.5 upstream (JEC WTW)'),
  ('diesel_kgco2_l',       3.20,  3.10,  3.30, 'kg CO2e/L',       'Well-to-wheel diesel: 2.66 combustion + ~0.55 upstream (JEC WTW)'),
  ('grid_loss_factor',     1.06,  1.04,  1.08, 'x',               'Transmission & distribution losses between power plant and plug'),
  ('car_build_tco2',       7.0,   6.0,   8.0,  't CO2e',          'Manufacturing a compact car body, chassis and drivetrain'),
  ('battery_kwh',         60.0,  50.0,  75.0,  'kWh',             'Battery capacity of a compact BEV'),
  ('battery_kgco2_kwh',   75.0,  50.0, 100.0,  'kg CO2e/kWh',     'Battery manufacturing footprint (ICCT 2021 range)'),
  ('lifetime_km',     200000.0, 150000.0, 250000.0, 'km',         'Lifetime distance of a passenger car in the EU'),
  ('annual_km',        15000.0, 15000.0, 15000.0, 'km/year',      'Distance used for annual running-cost comparisons'),
  ('public_charge_eur_kwh', 0.60, 0.45,  0.80, 'EUR/kWh',         'Typical public DC fast-charging tariff (scenario, not official data)')
) AS t(id, central, low, high, unit, note);

-- New registrations and fleet by motor energy, regrouped into powertrains
CREATE OR REPLACE VIEW stg_cars AS
WITH x AS (
    SELECT 'new' AS kind, geo_clean(geo) AS geo, time::INT AS year, mot_nrg, value::DOUBLE AS n FROM raw_new_registrations
    UNION ALL
    SELECT 'fleet', geo_clean(geo), time::INT, mot_nrg, value::DOUBLE FROM raw_car_fleet
)
SELECT kind, geo, year,
       max(n) FILTER (WHERE mot_nrg = 'TOTAL')                                              AS total,
       max(n) FILTER (WHERE mot_nrg = 'ELC')                                                AS bev,
       sum(n) FILTER (WHERE mot_nrg IN ('ELC_PET_PI', 'ELC_DIE_PI'))                        AS phev,
       sum(n) FILTER (WHERE mot_nrg IN ('ELC_PET_HYB', 'ELC_DIE_HYB'))                      AS hev,
       max(n) FILTER (WHERE mot_nrg = 'PET_X_HYB')                                          AS petrol,
       max(n) FILTER (WHERE mot_nrg = 'DIE_X_HYB')                                          AS diesel,
       max(n) FILTER (WHERE mot_nrg = 'PET')                                                AS petrol_incl_hyb,
       max(n) FILTER (WHERE mot_nrg = 'DIE')                                                AS diesel_incl_hyb
FROM x GROUP BY ALL;

CREATE OR REPLACE VIEW stg_production AS
SELECT geo_clean(geo) AS geo, time::INT AS year, value::DOUBLE AS idx_2021 FROM raw_production_index;

CREATE OR REPLACE VIEW stg_industry AS
SELECT geo_clean(geo) AS geo, time::INT AS year, nace_r2 AS nace, indic_sbs AS indicator, value::DOUBLE AS value
FROM raw_industry_sbs;

-- Comext values are in EUR; flows 1 = imports, 2 = exports
CREATE OR REPLACE VIEW stg_trade AS
SELECT time::INT AS year, CASE flow WHEN '1' THEN 'imports' ELSE 'exports' END AS flow,
       CASE partner WHEN 'CN' THEN 'China' ELSE 'Extra-EU' END AS partner, powertrain,
       sum(value::DOUBLE) FILTER (WHERE indicators = 'VALUE_IN_EUROS') AS eur
FROM raw_trade_cars
GROUP BY ALL;

-- Pump prices (weekly) and household electricity (half-yearly), EUR
CREATE OR REPLACE VIEW stg_fuel AS
SELECT geo_clean(geo) AS geo, date::DATE AS date, fuel, eur_per_1000l::DOUBLE / 1000 AS eur_per_l
FROM raw_fuel_prices;

CREATE OR REPLACE VIEW stg_electricity AS
SELECT geo_clean(geo) AS geo, time AS semester,
       make_date(left(time, 4)::INT, CASE right(time, 1) WHEN '1' THEN 1 ELSE 7 END, 1) AS period_start,
       value::DOUBLE AS eur_per_kwh
FROM raw_electricity_prices WHERE value IS NOT NULL;

-- Grid CO2 intensity of generation (Ember), g/kWh, and share of clean power
CREATE OR REPLACE VIEW stg_grid AS
SELECT geo, Year::INT AS year,
       max(Value::DOUBLE) FILTER (WHERE Variable = 'CO2 intensity') AS g_per_kwh,
       max(Value::DOUBLE) FILTER (WHERE Variable = 'Clean' AND Unit = '%') AS clean_share,
       max(Value::DOUBLE) FILTER (WHERE Variable = 'Wind and Solar' AND Unit = '%') AS wind_solar_share
FROM raw_grid_intensity
GROUP BY ALL;
