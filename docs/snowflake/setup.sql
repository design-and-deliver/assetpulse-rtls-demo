-- AssetPulse x Snowflake sandbox. Run once in a Snowsight worksheet as ACCOUNTADMIN on a TRIAL
-- account (pick Azure, a region near the App Service, e.g. East US 2). Nothing here touches the
-- production app: a server only uses these objects when SNOWFLAKE_ENABLED=1 is set on it.

USE ROLE ACCOUNTADMIN;

-- Compute: the smallest warehouse, asleep after 60 s idle, with a hard monthly credit cap.
CREATE WAREHOUSE IF NOT EXISTS ASSETPULSE_WH
  WAREHOUSE_SIZE = XSMALL AUTO_SUSPEND = 60 AUTO_RESUME = TRUE INITIALLY_SUSPENDED = TRUE;
CREATE RESOURCE MONITOR IF NOT EXISTS ASSETPULSE_RM
  WITH CREDIT_QUOTA = 20 FREQUENCY = MONTHLY START_TIMESTAMP = IMMEDIATELY
  TRIGGERS ON 80 PERCENT DO NOTIFY ON 100 PERCENT DO SUSPEND_IMMEDIATE;
ALTER WAREHOUSE ASSETPULSE_WH SET RESOURCE_MONITOR = ASSETPULSE_RM;
-- The monitor caps warehouse compute. Cortex AI calls bill separately (AI services credits);
-- the app's per-hospital cooldown and the trial's own credit limit are what bound those.

CREATE DATABASE IF NOT EXISTS ASSETPULSE;
CREATE SCHEMA IF NOT EXISTS ASSETPULSE.APP;
USE SCHEMA ASSETPULSE.APP;

-- One row per sequenced event. Columns match server/src/adapters/history-sink.ts (HistoryRow).
CREATE TABLE IF NOT EXISTS EVENTS (
  EVENT_TS    TIMESTAMP_TZ NOT NULL,
  HOSPITAL_ID STRING       NOT NULL,
  SEQ         NUMBER       NOT NULL,
  EVENT_TYPE  STRING       NOT NULL,  -- asset_changed | par_alert | work_order
  PAYLOAD     VARIANT,
  LOADED_AT   TIMESTAMP_TZ DEFAULT CURRENT_TIMESTAMP()
);

-- One row per work order: when it was opened, accepted, and closed, by whom, and how it ended.
-- A close is DELIVERED (pumps restocked) or CANCELLED (the shelf recovered first, or a reset);
-- only deliveries count toward delivery times. Rows from before close_code existed: an accepted
-- order was delivered, an unaccepted one was cancelled.
CREATE OR REPLACE VIEW WORK_ORDERS AS
WITH changes AS (
  SELECT HOSPITAL_ID, EVENT_TS,
         PAYLOAD:order:number::STRING      AS ORDER_NUMBER,
         PAYLOAD:order:state::STRING       AS STATE,
         PAYLOAD:order:assigned_to::STRING AS TECH,
         PAYLOAD:order:close_code::STRING  AS CLOSE_CODE,
         PAYLOAD:order:quantity::NUMBER    AS QUANTITY,
         PAYLOAD:order:location::STRING    AS LOCATION
  FROM EVENTS WHERE EVENT_TYPE = 'work_order'
),
orders AS (
  SELECT HOSPITAL_ID, ORDER_NUMBER,
         MAX(LOCATION) AS LOCATION,
         MAX(QUANTITY) AS QUANTITY,
         MAX(TECH)     AS TECH,
         UPPER(COALESCE(MAX(CLOSE_CODE), IFF(MAX(TECH) IS NULL, 'cancelled', 'delivered'))) AS CLOSE_CODE_RAW,
         MIN(IFF(STATE = 'open', EVENT_TS, NULL))     AS OPENED_AT,
         MIN(IFF(STATE = 'accepted', EVENT_TS, NULL)) AS ACCEPTED_AT,
         MIN(IFF(STATE = 'closed', EVENT_TS, NULL))   AS CLOSED_AT
  FROM changes
  GROUP BY HOSPITAL_ID, ORDER_NUMBER
)
SELECT HOSPITAL_ID, ORDER_NUMBER, LOCATION, QUANTITY, TECH, OPENED_AT, ACCEPTED_AT, CLOSED_AT,
       IFF(CLOSED_AT IS NULL, NULL, CLOSE_CODE_RAW)                  AS CLOSE_CODE,  -- DELIVERED | CANCELLED
       IFF(CLOSE_CODE_RAW = 'DELIVERED', CLOSED_AT, NULL)           AS DELIVERED_AT,
       IFF(CLOSE_CODE_RAW = 'CANCELLED', CLOSED_AT, NULL)           AS CANCELLED_AT,
       DATEDIFF('second', OPENED_AT, ACCEPTED_AT) / 60.0            AS MINUTES_TO_ACCEPT,
       DATEDIFF('second', OPENED_AT, DELIVERED_AT) / 60.0           AS MINUTES_TO_DELIVER
FROM orders;

-- Shelf PAR breaches and recoveries.
CREATE OR REPLACE VIEW PAR_ALERTS AS
SELECT HOSPITAL_ID, EVENT_TS,
       PAYLOAD:zoneId::STRING AS ZONE_ID,
       PAYLOAD:state::STRING  AS STATE,   -- BREACH | CLEARED
       PAYLOAD:clean::NUMBER  AS CLEAN_COUNT,
       PAYLOAD:min::NUMBER    AS PAR_MIN,
       PAYLOAD:max::NUMBER    AS PAR_MAX
FROM EVENTS WHERE EVENT_TYPE = 'par_alert';

-- Every pump move between zones.
CREATE OR REPLACE VIEW ASSET_MOVES AS
SELECT HOSPITAL_ID, EVENT_TS,
       PAYLOAD:assetId::STRING AS ASSET_ID,
       PAYLOAD:from::STRING    AS FROM_ZONE,
       PAYLOAD:to::STRING      AS TO_ZONE,
       PAYLOAD:status::STRING  AS STATUS
FROM EVENTS WHERE EVENT_TYPE = 'asset_changed';

-- Remediation (/remediation): each customer's vulnerable devices, and the projects that fix them.
-- CUSTOMER_ID is the sandbox id (?h=) and leads every key: the app filters on it in every query.
-- A customer's fleet is generated and inserted by the app on its first visit.
CREATE TABLE IF NOT EXISTS REMEDIATION_DEVICES (
  CUSTOMER_ID  STRING       NOT NULL,
  DEVICE_ID    STRING       NOT NULL,
  ASSET_TAG    STRING       NOT NULL,
  MODEL        STRING       NOT NULL,
  DEVICE_CLASS STRING       NOT NULL,
  MANUFACTURER STRING       NOT NULL,
  HOSPITAL     STRING       NOT NULL,
  CVE          STRING       NOT NULL,
  CVSS         NUMBER(3, 1) NOT NULL,
  SEVERITY     STRING       NOT NULL,  -- Critical | High | Medium | Low
  PRIMARY KEY (CUSTOMER_ID, DEVICE_ID)
);

CREATE TABLE IF NOT EXISTS REMEDIATION_PROJECTS (
  CUSTOMER_ID STRING       NOT NULL,
  PROJECT_ID  STRING       NOT NULL,
  NAME        STRING       NOT NULL,
  STATUS      STRING       NOT NULL,  -- Open | In progress | Done
  CREATED_AT  TIMESTAMP_TZ NOT NULL,
  PRIMARY KEY (CUSTOMER_ID, PROJECT_ID)
);

CREATE TABLE IF NOT EXISTS REMEDIATION_PROJECT_DEVICES (
  CUSTOMER_ID STRING NOT NULL,
  PROJECT_ID  STRING NOT NULL,
  DEVICE_ID   STRING NOT NULL
);

-- Each device with its remediation status: Remediated once in a Done project, Planned while in
-- any other, else Unplanned. Inner-joining projects means links whose project row was never
-- written (a failed create) count for nothing.
CREATE OR REPLACE VIEW REMEDIATION_FLEET AS
WITH project_status AS (
  SELECT pd.CUSTOMER_ID, pd.DEVICE_ID, MAX(IFF(p.STATUS = 'Done', 2, 1)) AS STAGE
  FROM REMEDIATION_PROJECT_DEVICES pd
  JOIN REMEDIATION_PROJECTS p
    ON p.CUSTOMER_ID = pd.CUSTOMER_ID AND p.PROJECT_ID = pd.PROJECT_ID
  GROUP BY 1, 2
)
SELECT d.CUSTOMER_ID, d.DEVICE_ID, d.ASSET_TAG, d.MODEL, d.DEVICE_CLASS, d.MANUFACTURER,
       d.HOSPITAL, d.CVE, d.CVSS, d.SEVERITY,
       DECODE(s.STAGE, 2, 'Remediated', 1, 'Planned', 'Unplanned') AS STATUS
FROM REMEDIATION_DEVICES d
LEFT JOIN project_status s ON s.CUSTOMER_ID = d.CUSTOMER_ID AND s.DEVICE_ID = d.DEVICE_ID;

-- Where the Cortex Analyst semantic model lives. Upload docs/snowflake/assetpulse.yaml here
-- (Snowsight: Data > ASSETPULSE > APP > Stages > MODELS > + Files).
CREATE STAGE IF NOT EXISTS MODELS DIRECTORY = (ENABLE = TRUE);

-- The app's role: insert events, read the views, use Cortex, and keep remediation data. Nothing else.
CREATE ROLE IF NOT EXISTS ASSETPULSE_APP;
GRANT USAGE ON WAREHOUSE ASSETPULSE_WH TO ROLE ASSETPULSE_APP;
GRANT USAGE ON DATABASE ASSETPULSE TO ROLE ASSETPULSE_APP;
GRANT USAGE ON SCHEMA ASSETPULSE.APP TO ROLE ASSETPULSE_APP;
GRANT INSERT, SELECT ON TABLE EVENTS TO ROLE ASSETPULSE_APP;
GRANT SELECT ON VIEW WORK_ORDERS TO ROLE ASSETPULSE_APP;
GRANT SELECT ON VIEW PAR_ALERTS TO ROLE ASSETPULSE_APP;
GRANT SELECT ON VIEW ASSET_MOVES TO ROLE ASSETPULSE_APP;
GRANT READ ON STAGE MODELS TO ROLE ASSETPULSE_APP;
GRANT INSERT, SELECT ON TABLE REMEDIATION_DEVICES TO ROLE ASSETPULSE_APP;
GRANT INSERT, SELECT, UPDATE ON TABLE REMEDIATION_PROJECTS TO ROLE ASSETPULSE_APP;
GRANT INSERT, SELECT ON TABLE REMEDIATION_PROJECT_DEVICES TO ROLE ASSETPULSE_APP;
GRANT SELECT ON VIEW REMEDIATION_FLEET TO ROLE ASSETPULSE_APP;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ASSETPULSE_APP;

-- A service user that signs in with a key pair only (no password). Paste the body of
-- rsa_key.pub (between the BEGIN/END lines, joined into one line) below.
CREATE USER IF NOT EXISTS ASSETPULSE_SVC
  TYPE = SERVICE
  DEFAULT_ROLE = ASSETPULSE_APP
  DEFAULT_WAREHOUSE = ASSETPULSE_WH
  RSA_PUBLIC_KEY = 'PASTE_PUBLIC_KEY_HERE';
GRANT ROLE ASSETPULSE_APP TO USER ASSETPULSE_SVC;

-- If Cortex Analyst or AI_SUMMARIZE_AGG reports it isn't available in your region, allow
-- cross-region inference (requests are processed in another region):
-- ALTER ACCOUNT SET CORTEX_ENABLED_CROSS_REGION = 'ANY_REGION';

-- Check: after the app runs a minute with the flag on, this returns rows.
-- SELECT EVENT_TYPE, COUNT(*) FROM EVENTS GROUP BY 1;
