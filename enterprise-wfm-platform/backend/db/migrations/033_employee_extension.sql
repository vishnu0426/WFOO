-- The agent's phone/softphone extension on the ACD, separate from their mobile/contact phone number.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS extension text;
