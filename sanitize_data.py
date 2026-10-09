import csv
import re

def sanitize_and_flag_csv(input_filepath, output_filepath):
    # 1. Explicit columns to drop completely to protect privacy
    columns_to_drop = {"Navn", "E-postadresse", "$answer_time_ms", "$submission_id", "$created"}
    
    # 2. Regex patterns to detect stray PII hidden inside text/comment fields
    email_pattern = re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b')
    # Norwegian phone number pattern (8 digits, optional +47 or spaces)
    phone_pattern = re.compile(r'\b(?:\+47)?[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2}[\s\-]?\d{2}\b|\b\d{8}\b')
    
    flagged_rows = []
    cleaned_rows = []
    
    print(f"Reading input file: {input_filepath}...")
    
    with open(input_filepath, mode='r', encoding='utf-8-sig') as infile:
        # The data uses semicolon separation based on your sample
        reader = csv.DictReader(infile, delimiter=';')
        
        # Filter out unwanted columns from the header
        fieldnames = [f for f in reader.fieldnames if f not in columns_to_drop]
        
        for row_idx, row in enumerate(reader, start=1):
            row_flags = []
            
            # Scan all remaining columns (especially comments) for hidden PII
            for col, val in row.items():
                if val:
                    # Check for stray emails
                    if email_pattern.search(val):
                        row_flags.append(f"Email found in '{col}': {val}")
                        row[col] = email_pattern.sub("[REDACTED_EMAIL]", val)
                        
                    # Check for stray phone numbers
                    if phone_pattern.search(val):
                        row_flags.append(f"Potential phone number found in '{col}': {val}")
                        row[col] = phone_pattern.sub("[REDACTED_PHONE]", val)
            
            if row_flags:
                flagged_rows.append((row_idx, row_flags))
            
            # Keep only the safe columns
            cleaned_row = {k: row[k] for k in fieldnames if k in row}
            cleaned_rows.append(cleaned_row)
            
    # Write out the clean, safe CSV file
    with open(output_filepath, mode='w', encoding='utf-8', newline='') as outfile:
        writer = csv.DictWriter(outfile, fieldnames=fieldnames, delimiter=';')
        writer.writeheader()
        writer.writerows(cleaned_rows)
        
    print("\n================== SANITIZATION REPORT ==================")
    print(f"Safe CSV successfully saved to: {output_filepath}")
    print(f"Total rows processed: {len(cleaned_rows)}")
    print(f"Rows flagged with potential hidden PII: {len(flagged_rows)}")
    
    if flagged_rows:
        print("\n--- Detailed Flags (Emails/Phones found in comments) ---")
        for r_idx, flags in flagged_rows:
            print(f"Row {r_idx}:")
            for flag in flags:
                print(f"  * {flag}")
    print("=========================================================")

if __name__ == "__main__":
    # Replace 'raw_data.csv' with the actual filename of your raw export
    input_file = "raw_data.csv" 
    output_file = "safe_sampling_data.csv"
    sanitize_and_flag_csv(input_file, output_file)