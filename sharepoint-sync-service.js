// ============================================================================
// SharePoint Sync Service - Fetches Excel files and syncs to database
// ============================================================================

const { createClient } = require('@supabase/supabase-js');
const XLSX = require('xlsx');
const axios = require('axios');

// SharePoint configuration
const SHAREPOINT_CONFIG = {
  infoRecordUrl: 'https://tke.sharepoint.com/:x:/r/teams/PSM-MFG68/Shared%20Documents/General/SAP%20DATA/Info%20Record%20Report%2023.02.2026.XLSX',
  porvUrl: 'https://tke.sharepoint.com/:x:/r/teams/PSM-MFG68/Shared%20Documents/General/SAP%20DATA/PORV%20OCT%2024%20TO%20SEP%2025.xlsx',
  
  // Column mappings for Info Record file
  infoRecordColumns: {
    materialNumber: 'Material Number',
    materialDescription: 'Material',
    vendorAccountNumber: 'Vendor account number',
    supplierName: 'Supplier',
    amount: 'Amount',
    validFrom: 'Valid From',
    validTo: 'Valid To'
  },
  
  // Column mappings for PORV file
  porvColumns: {
    vendorId: 'Vendor ID',
    itemCode: 'Item Code',
    qtyInUnitOfEntry: 'Qty in unit of entry'
  }
};

class SharePointSyncService {
  constructor(supabaseUrl, supabaseKey) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Download Excel file from SharePoint
   * Note: This requires authentication token from frontend
   */
  async downloadSharePointFile(url, accessToken) {
    try {
      // SharePoint URLs need to be converted to download URLs
      const downloadUrl = this.convertToDownloadUrl(url);
      
      const response = await axios.get(downloadUrl, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        },
        responseType: 'arraybuffer'
      });
      
      return response.data;
    } catch (error) {
      throw new Error(`SharePoint download failed: ${error.message}`);
    }
  }

  /**
   * Convert SharePoint sharing URL to direct download URL
   */
  convertToDownloadUrl(shareUrl) {
    // SharePoint sharing URLs need specific conversion
    // Format: https://[tenant].sharepoint.com/.../_layouts/15/download.aspx?...
    // This is simplified - actual implementation may need OAuth
    return shareUrl.replace(':x:', '/_layouts/15/download.aspx');
  }

  /**
   * Parse Excel file and return data
   */
  parseExcelFile(buffer, columnMapping) {
    try {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(firstSheet, { raw: false });
      
      // Map columns to standardized names
      return data.map(row => {
        const mapped = {};
        for (const [key, excelColumn] of Object.entries(columnMapping)) {
          mapped[key] = row[excelColumn] || null;
        }
        return mapped;
      });
    } catch (error) {
      throw new Error(`Excel parsing failed: ${error.message}`);
    }
  }

  /**
   * Sync Info Records from SharePoint to database
   */
  async syncInfoRecords(accessToken, syncedBy) {
    const syncId = await this.createSyncRecord('info_records', syncedBy);
    
    try {
      // Download file
      const fileBuffer = await this.downloadSharePointFile(
        SHAREPOINT_CONFIG.infoRecordUrl,
        accessToken
      );
      
      // Parse Excel
      const records = this.parseExcelFile(
        fileBuffer,
        SHAREPOINT_CONFIG.infoRecordColumns
      );
      
      // Clear existing records
      await this.supabase.from('info_records').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      
      // Insert new records in batches
      let successCount = 0;
      let failCount = 0;
      const batchSize = 100;
      
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        
        const processedBatch = batch.map(record => ({
          material_number: record.materialNumber?.trim(),
          material_description: record.materialDescription?.trim(),
          vendor_account_number: record.vendorAccountNumber?.trim(),
          supplier_name: record.supplierName?.trim(),
          amount: parseFloat(record.amount) || 0,
          valid_from: this.parseDate(record.validFrom),
          valid_to: this.parseDate(record.validTo),
          item_vendor_key: `${record.materialNumber?.trim()}-${record.vendorAccountNumber?.trim()}`
        })).filter(r => r.material_number && r.vendor_account_number);
        
        const { error } = await this.supabase
          .from('info_records')
          .insert(processedBatch);
        
        if (error) {
          failCount += processedBatch.length;
          console.error('Batch insert error:', error);
        } else {
          successCount += processedBatch.length;
        }
      }
      
      // Update sync status
      await this.completeSyncRecord(syncId, 'success', successCount, failCount);
      
      return {
        success: true,
        recordsSynced: successCount,
        recordsFailed: failCount
      };
      
    } catch (error) {
      await this.completeSyncRecord(syncId, 'failed', 0, 0, error.message);
      throw error;
    }
  }

  /**
   * Sync PORV data from SharePoint to database
   */
  async syncPorvData(accessToken, syncedBy) {
    const syncId = await this.createSyncRecord('porv_data', syncedBy);
    
    try {
      // Download file
      const fileBuffer = await this.downloadSharePointFile(
        SHAREPOINT_CONFIG.porvUrl,
        accessToken
      );
      
      // Parse Excel
      const records = this.parseExcelFile(
        fileBuffer,
        SHAREPOINT_CONFIG.porvColumns
      );
      
      // Clear existing records
      await this.supabase.from('porv_data').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      
      // Insert new records in batches
      let successCount = 0;
      let failCount = 0;
      const batchSize = 100;
      
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        
        const processedBatch = batch.map(record => ({
          vendor_id: record.vendorId?.trim(),
          item_code: record.itemCode?.trim(),
          qty_in_unit_of_entry: parseFloat(record.qtyInUnitOfEntry) || 0,
          item_vendor_key: `${record.itemCode?.trim()}-${record.vendorId?.trim()}`
        })).filter(r => r.item_code && r.vendor_id);
        
        const { error } = await this.supabase
          .from('porv_data')
          .insert(processedBatch);
        
        if (error) {
          failCount += processedBatch.length;
          console.error('Batch insert error:', error);
        } else {
          successCount += processedBatch.length;
        }
      }
      
      // Update sync status
      await this.completeSyncRecord(syncId, 'success', successCount, failCount);
      
      return {
        success: true,
        recordsSynced: successCount,
        recordsFailed: failCount
      };
      
    } catch (error) {
      await this.completeSyncRecord(syncId, 'failed', 0, 0, error.message);
      throw error;
    }
  }

  /**
   * Sync both files at once
   */
  async syncAll(accessToken, syncedBy) {
    const results = {
      infoRecords: null,
      porvData: null,
      errors: []
    };
    
    try {
      results.infoRecords = await this.syncInfoRecords(accessToken, syncedBy);
    } catch (error) {
      results.errors.push(`Info Records: ${error.message}`);
    }
    
    try {
      results.porvData = await this.syncPorvData(accessToken, syncedBy);
    } catch (error) {
      results.errors.push(`PORV Data: ${error.message}`);
    }
    
    return results;
  }

  /**
   * Get sync status - when was data last updated
   */
  async getSyncStatus() {
    const { data, error } = await this.supabase
      .from('sync_status')
      .select('*')
      .in('sync_type', ['info_records', 'porv_data', 'full'])
      .eq('status', 'success')
      .order('completed_at', { ascending: false })
      .limit(10);
    
    if (error) {
      throw error;
    }
    
    // Group by sync type
    const statusByType = {
      info_records: data.find(s => s.sync_type === 'info_records') || null,
      porv_data: data.find(s => s.sync_type === 'porv_data') || null,
      last_full_sync: data.find(s => s.sync_type === 'full') || null
    };
    
    return statusByType;
  }

  /**
   * Helper: Create sync record
   */
  async createSyncRecord(syncType, syncedBy) {
    const { data, error } = await this.supabase
      .from('sync_status')
      .insert({
        sync_type: syncType,
        status: 'in_progress',
        synced_by: syncedBy
      })
      .select()
      .single();
    
    if (error) throw error;
    return data.id;
  }

  /**
   * Helper: Complete sync record
   */
  async completeSyncRecord(syncId, status, recordsSynced, recordsFailed, errorMessage = null) {
    await this.supabase
      .from('sync_status')
      .update({
        status,
        completed_at: new Date().toISOString(),
        records_synced: recordsSynced,
        records_failed: recordsFailed,
        error_message: errorMessage
      })
      .eq('id', syncId);
  }

  /**
   * Helper: Parse Excel date to ISO format
   */
  parseDate(excelDate) {
    if (!excelDate) return null;
    
    // Excel stores dates as numbers (days since 1900-01-01)
    if (typeof excelDate === 'number') {
      const date = XLSX.SSF.parse_date_code(excelDate);
      return new Date(date.y, date.m - 1, date.d).toISOString().split('T')[0];
    }
    
    // If already a string, try to parse
    try {
      return new Date(excelDate).toISOString().split('T')[0];
    } catch {
      return null;
    }
  }
}

module.exports = SharePointSyncService;
