-- The requester's own words for what a system does, saved with the case
-- they submitted. The words are a note, so an erasure request can remove
-- them like any other free text; the case keeps only the note's id, with no
-- foreign key, as the audit log does.

ALTER TABLE cases ADD COLUMN purpose_note_id uuid;
