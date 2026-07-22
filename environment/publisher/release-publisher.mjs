#!/usr/bin/env node

import duckdb from 'duckdb';
import fs from 'fs';
import { execSync } from 'child_process';

const DB_PATH = './releases.duckdb';
const MANIFEST_PATH = './fixtures/build_manifest.csv';

const GATEWAY_BASE = 'http://127.0.0.1:7070';

const CURRENT_KEY_PATH = './keys/current/current.key.pem';
const CURRENT_CERT_PATH = './keys/current/current.cert.pem';


function runQuery(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.all(sql, ...params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}


function runExec(conn, sql, params = []) {
  return new Promise((resolve, reject) => {
    conn.run(sql, ...params, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}


async function main() {

  const db = new duckdb.Database(DB_PATH);
  const conn = db.connect();


  try {

    // Create publication ledger for idempotency
    await runExec(conn, `
      CREATE TABLE IF NOT EXISTS publications (
        request_token TEXT PRIMARY KEY,
        publication_id TEXT,
        receipt TEXT
      )
    `);


    // Load manifest CSV without header
    await runExec(conn, `
      CREATE TABLE IF NOT EXISTS builds AS
      SELECT *
      FROM read_csv(
        '${MANIFEST_PATH}',
        header=false,
        columns={
          'entry_id':'VARCHAR',
          'bundle_id':'VARCHAR',
          'component_id':'VARCHAR',
          'version':'VARCHAR',
          'size_bytes':'BIGINT',
          'record_type':'VARCHAR',
          'supersedes_id':'VARCHAR',
          'recorded_at':'VARCHAR'
        }
      )
    `);


    // Reconcile:
    // - remove duplicates
    // - remove withdrawn builds
    // - keep only active BUILD records

    const bundles = await runQuery(conn, `

      WITH deduped AS (

        SELECT DISTINCT *
        FROM builds

      ),

      active_builds AS (

        SELECT b.*

        FROM deduped b

        LEFT JOIN deduped w
          ON b.entry_id = w.supersedes_id
          AND w.record_type = 'WITHDRAWAL'

        WHERE w.entry_id IS NULL
          AND b.record_type = 'BUILD'

      ),

      bundle_summary AS (

        SELECT

          bundle_id,
          COUNT(*) AS artifact_count,
          SUM(size_bytes) AS total_bytes

        FROM active_builds

        GROUP BY bundle_id

      )

      SELECT *
      FROM bundle_summary

      ORDER BY bundle_id

    `);



    // Fetch current signing key metadata

    const keyResponse = await fetch(
      `${GATEWAY_BASE}/v1/signing-key/current`
    );


    if (!keyResponse.ok) {
      throw new Error("Unable to get current signing key");
    }


    const signingKey = await keyResponse.json();



    for (const bundle of bundles) {


      const bundleId = bundle.bundle_id;

      const requestToken = `token-${bundleId}`;



      // Idempotency check

      const existing = await runQuery(
        conn,
        `
        SELECT publication_id
        FROM publications
        WHERE request_token = ?
        `,
        [requestToken]
      );


      if (existing.length > 0) {

        console.log(
          `BUNDLE ${bundleId} SIGNED KEY=${signingKey.key_id}`
        );

        console.log(
          `BUNDLE ${bundleId} PUBLISHED RECEIPT=${existing[0].publication_id} TOKEN=${requestToken} STATUS=PUBLISHED`
        );

        continue;

      }



      // Canonical descriptor
      // Keys are already lexicographically sorted

      const descriptor = JSON.stringify({

        artifact_count: Number(bundle.artifact_count),

        bundle_id: bundleId,

        total_bytes: Number(bundle.total_bytes)

      });



      const descriptorFile =
        `./${bundleId}.json`;


      const signatureFile =
              `./${bundleId}.sig.pem`;



      fs.writeFileSync(
        descriptorFile,
        descriptor,
        'utf8'
      );



      // Detached CMS signature using CURRENT key only

      execSync(
        [
          'openssl cms -sign',
          `-in "${descriptorFile}"`,
          `-signer "${CURRENT_CERT_PATH}"`,
          `-inkey "${CURRENT_KEY_PATH}"`,
          '-outform PEM',
          '-binary',
          `-out "${signatureFile}"`
        ].join(' '),
        {
          stdio: 'ignore'
        }
      );



      const signature =
        fs.readFileSync(signatureFile, 'utf8');



      fs.unlinkSync(descriptorFile);
      fs.unlinkSync(signatureFile);



      // Send to gateway

      const publishResponse = await fetch(
        `${GATEWAY_BASE}/v1/publications`,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json'
          },

          body: JSON.stringify({

            descriptor,

            signature,

            request_token: requestToken

          })
        }
      );



      const receipt =
        await publishResponse.json();



      if (!publishResponse.ok) {

        throw new Error(
          JSON.stringify(receipt)
        );

      }



      // Save receipt

      await runExec(
        conn,
        `
        INSERT INTO publications
        VALUES (?, ?, ?)
        `,
        [
          requestToken,
          receipt.publication_id,
          JSON.stringify(receipt)
        ]
      );



      console.log(
        `BUNDLE ${bundleId} SIGNED KEY=${signingKey.key_id}`
      );


      console.log(
        `BUNDLE ${bundleId} PUBLISHED RECEIPT=${receipt.publication_id} TOKEN=${requestToken} STATUS=PUBLISHED`
      );

    }


  } finally {

    conn.close();

    db.close();

  }

}



main()
.catch(error => {

  console.error(error);

  process.exit(1);

});