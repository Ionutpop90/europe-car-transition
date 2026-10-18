-- =====================================================================
-- 02 · MARTS
-- =====================================================================

CREATE OR REPLACE MACRO a(name) AS (SELECT central FROM dim_assumption WHERE id = name);

-- Q1 · The switch: powertrain mix of new cars (shares, %)
CREATE OR REPLACE VIEW mart_mix AS
SELECT geo, year, total,
       100 * bev / total    AS bev_pct,
       100 * phev / total   AS phev_pct,
       100 * hev / total    AS hev_pct,
       100 * petrol / total AS petrol_pct,
       100 * diesel / total AS diesel_pct,
       100 * (total - coalesce(bev, 0) - coalesce(phev, 0) - coalesce(hev, 0) - coalesce(petrol, 0) - coalesce(diesel, 0)) / total AS other_pct
FROM stg_cars WHERE kind = 'new' AND total > 0;

-- Q2 · Electric share of new cars and of the fleet, by country
CREATE OR REPLACE VIEW mart_bev_country AS
WITH n AS (SELECT geo, year, 100 * bev / total AS share FROM stg_cars WHERE kind = 'new' AND total > 0),
     f AS (SELECT geo, year, 100 * bev / total AS share FROM stg_cars WHERE kind = 'fleet' AND total > 0)
SELECT n.geo,
       arg_max(n.share, n.year)                      AS bev_new_pct,
       max(n.year)                                   AS bev_new_year,
       max(n.share) FILTER (WHERE n.year = 2020)     AS bev_new_2020,
       (SELECT arg_max(share, year) FROM f WHERE f.geo = n.geo) AS bev_fleet_pct
FROM n GROUP BY n.geo;

-- Q3 · Industry: production volume and employment
CREATE OR REPLACE VIEW mart_production AS
SELECT geo, year, idx_2021,
       round(100 * idx_2021 / max(idx_2021) FILTER (WHERE year = 2017) OVER (PARTITION BY geo), 1) AS idx_2017
FROM stg_production WHERE idx_2021 IS NOT NULL;

CREATE OR REPLACE VIEW mart_industry AS
SELECT geo, year,
       max(value) FILTER (WHERE nace = 'C29' AND indicator = 'EMP_NR')     AS jobs,
       max(value) FILTER (WHERE nace = 'C29' AND indicator = 'AV_MEUR')    AS value_added_meur,
       max(value) FILTER (WHERE nace = 'C29' AND indicator = 'EMP_MFG_PC') AS share_of_mfg_jobs,
       max(value) FILTER (WHERE nace = 'C' AND indicator = 'AV_MEUR')      AS mfg_value_added_meur
FROM stg_industry GROUP BY ALL;

-- Q4 · Trade with China and the world
CREATE OR REPLACE VIEW mart_trade AS
SELECT year, partner, powertrain,
       max(eur) FILTER (WHERE flow = 'exports') / 1e9 AS exports_bn,
       max(eur) FILTER (WHERE flow = 'imports') / 1e9 AS imports_bn,
       (coalesce(max(eur) FILTER (WHERE flow = 'exports'), 0) - coalesce(max(eur) FILTER (WHERE flow = 'imports'), 0)) / 1e9 AS balance_bn
FROM stg_trade GROUP BY ALL;

-- Q5 · Running cost per 100 km, latest prices
CREATE OR REPLACE VIEW mart_costs AS
WITH fuel AS (
    SELECT geo,
           arg_max(eur_per_l, date) FILTER (WHERE fuel = 'euro95') AS petrol_eur_l,
           arg_max(eur_per_l, date) FILTER (WHERE fuel = 'diesel') AS diesel_eur_l,
           max(date) AS fuel_date
    FROM stg_fuel GROUP BY geo
),
elec AS (SELECT geo, arg_max(eur_per_kwh, period_start) AS eur_kwh, max(semester) AS elec_period FROM stg_electricity GROUP BY geo)
SELECT f.geo, f.fuel_date, e.elec_period,
       f.petrol_eur_l, f.diesel_eur_l, e.eur_kwh,
       f.petrol_eur_l * a('petrol_l_100km')           AS petrol_100km,
       f.diesel_eur_l * a('diesel_l_100km')           AS diesel_100km,
       e.eur_kwh * a('bev_kwh_100km')                 AS bev_home_100km,
       a('public_charge_eur_kwh') * a('bev_kwh_100km') AS bev_public_100km,
       (f.petrol_eur_l * a('petrol_l_100km') - e.eur_kwh * a('bev_kwh_100km')) * a('annual_km') / 100 AS annual_saving_home
FROM fuel f JOIN elec e USING (geo);

-- Running cost over time, EU-27 (annual averages)
CREATE OR REPLACE VIEW mart_costs_eu_trend AS
WITH f AS (SELECT year(date) AS year, avg(eur_per_l) AS petrol FROM stg_fuel WHERE geo = 'EU27' AND fuel = 'euro95' GROUP BY 1),
     e AS (SELECT year(period_start) AS year, avg(eur_per_kwh) AS elec FROM stg_electricity WHERE geo = 'EU27' GROUP BY 1)
SELECT year, f.petrol, e.elec,
       f.petrol * a('petrol_l_100km') AS petrol_100km,
       e.elec * a('bev_kwh_100km')    AS bev_home_100km
FROM f JOIN e USING (year) ORDER BY year;

-- Q6 · Lifecycle CO2 per km, central assumptions, latest grid mix
CREATE OR REPLACE VIEW mart_lifecycle AS
WITH g AS (SELECT geo, arg_max(g_per_kwh, year) AS grid_g_kwh, arg_max(clean_share, year) AS clean_share, max(year) AS grid_year
           FROM stg_grid GROUP BY geo),
p AS (
    SELECT a('petrol_l_100km') AS pl, a('petrol_kgco2_l') AS pf, a('bev_kwh_100km') AS ek, a('grid_loss_factor') AS loss,
           a('car_build_tco2') AS build, a('battery_kwh') * a('battery_kgco2_kwh') / 1000 AS battery_t, a('lifetime_km') AS km
)
SELECT g.geo, g.grid_year, g.grid_g_kwh, g.clean_share,
       1e6 * p.build / p.km                                     AS petrol_build_g_km,
       p.pl / 100 * p.pf * 1000                                 AS petrol_use_g_km,
       1e6 * (p.build + p.battery_t) / p.km                     AS bev_build_g_km,
       p.ek / 100 * g.grid_g_kwh * p.loss                       AS bev_use_g_km,
       1e6 * p.build / p.km + p.pl / 100 * p.pf * 1000          AS petrol_total_g_km,
       1e6 * (p.build + p.battery_t) / p.km + p.ek / 100 * g.grid_g_kwh * p.loss AS bev_total_g_km,
       -- distance after which the battery's extra manufacturing emissions are paid back
       1e6 * p.battery_t / (p.pl / 100 * p.pf * 1000 - p.ek / 100 * g.grid_g_kwh * p.loss) AS breakeven_km
FROM g, p;
