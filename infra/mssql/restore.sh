#!/bin/bash
# Starts SQL Server, restores the legacy DNN backup once as [PipsLegacy], creates a read-only login
# (pips_reader, db_datareader) and marks the database READ_ONLY. Re-runs are no-ops.
set -euo pipefail

/opt/mssql/bin/sqlservr &
SQL_PID=$!

SQLCMD=/opt/mssql-tools18/bin/sqlcmd
q() { "$SQLCMD" -S localhost -U sa -P "$MSSQL_SA_PASSWORD" -C -b -h -1 -W -Q "SET NOCOUNT ON; $1"; }

for i in $(seq 1 60); do
  if q "SELECT 1" >/dev/null 2>&1; then break; fi
  sleep 2
done

if [ "$(q "SELECT COUNT(*) FROM sys.databases WHERE name = 'PipsLegacy'" | tr -d '[:space:]')" = "0" ]; then
  echo "[restore] restoring /bak/${LEGACY_BAK_FILE} -> PipsLegacy"
  DATA=$(q "RESTORE FILELISTONLY FROM DISK = N'/bak/${LEGACY_BAK_FILE}'" | awk 'NR==1{print $1}')
  LOG=$(q "RESTORE FILELISTONLY FROM DISK = N'/bak/${LEGACY_BAK_FILE}'" | awk 'NR==2{print $1}')
  q "RESTORE DATABASE [PipsLegacy] FROM DISK = N'/bak/${LEGACY_BAK_FILE}'
     WITH MOVE N'${DATA}' TO N'/var/opt/mssql/data/PipsLegacy.mdf',
          MOVE N'${LOG}'  TO N'/var/opt/mssql/data/PipsLegacy_log.ldf'"
  q "IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'pips_reader')
       CREATE LOGIN pips_reader WITH PASSWORD = N'${LEGACY_READER_PASSWORD}', CHECK_POLICY = OFF"
  q "USE [PipsLegacy];
     IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'pips_reader')
       CREATE USER pips_reader FOR LOGIN pips_reader;
     ALTER ROLE db_datareader ADD MEMBER pips_reader;"
  q "ALTER DATABASE [PipsLegacy] SET READ_ONLY WITH ROLLBACK IMMEDIATE"
  echo "[restore] done: PipsLegacy is READ_ONLY; login pips_reader has db_datareader"
else
  echo "[restore] PipsLegacy already present"
fi

wait $SQL_PID
