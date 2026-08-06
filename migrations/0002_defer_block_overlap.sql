-- Make the R-01 non-overlap constraint deferrable.
--
-- Push-down (§5.4) repositions a chain of blocks within one transaction (R-07). Moving
-- them one statement at a time creates transient overlaps that are resolved by the end
-- of the transaction. With an immediately-checked constraint those intermediate states
-- fail. DEFERRABLE INITIALLY IMMEDIATE keeps normal single inserts checked at once, while
-- the placement transaction issues `SET CONSTRAINTS blocks_no_overlap DEFERRED` so only
-- the committed final state is validated.

ALTER TABLE blocks DROP CONSTRAINT blocks_no_overlap;

ALTER TABLE blocks ADD CONSTRAINT blocks_no_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    date WITH =,
    int4range(start_min, start_min + duration_min) WITH &&
  ) WHERE (deleted_at IS NULL)
  DEFERRABLE INITIALLY IMMEDIATE;
