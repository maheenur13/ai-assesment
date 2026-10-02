-- Runs once on first volume init. The app database is created from POSTGRES_DB;
-- this adds an isolated database for the automated test suite.
CREATE DATABASE shop_test;
