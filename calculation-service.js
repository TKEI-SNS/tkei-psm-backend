// ============================================================================
// Calculation Service - Price lookups, PORV lookups, Impact calculations
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

class CalculationService {
  constructor(supabaseUrl, supabaseKey) {
    this.supabase = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Get old price for item-vendor combination with fallback
   * 1. Try exact match: Item + Vendor
   * 2. If not found: Try Item with ANY vendor (latest)
   * 3. If not found: Mark as "New Item"
   */
  async getOldPrice(materialNumber, vendorAccountNumber) {
    try {
      const itemVendorKey = `${materialNumber}-${vendorAccountNumber}`;
      
      // Step 1: Try exact match
      const { data: exactMatch, error: exactError } = await this.supabase
        .from('info_records')
        .select('amount, valid_to, material_description, supplier_name, vendor_account_number')
        .eq('item_vendor_key', itemVendorKey)
        .order('valid_to', { ascending: false, nullsFirst: true })
        .limit(1);
      
      if (!exactError && exactMatch && exactMatch.length > 0) {
        return {
          found: true,
          exactMatch: true,
          oldPrice: parseFloat(exactMatch[0].amount),
          validTo: exactMatch[0].valid_to,
          materialDescription: exactMatch[0].material_description,
          supplierName: exactMatch[0].supplier_name,
          vendorUsed: vendorAccountNumber,
          remarks: null
        };
      }
      
      // Step 2: Try any vendor for this item
      const { data: anyVendor, error: anyError } = await this.supabase
        .from('info_records')
        .select('amount, valid_to, material_description, supplier_name, vendor_account_number')
        .eq('material_number', materialNumber)
        .order('valid_to', { ascending: false, nullsFirst: true })
        .limit(1);
      
      if (!anyError && anyVendor && anyVendor.length > 0) {
        return {
          found: true,
          exactMatch: false,
          oldPrice: parseFloat(anyVendor[0].amount),
          validTo: anyVendor[0].valid_to,
          materialDescription: anyVendor[0].material_description,
          supplierName: anyVendor[0].supplier_name,
          vendorUsed: anyVendor[0].vendor_account_number,
          remarks: `Old price from different vendor: ${anyVendor[0].vendor_account_number} (${anyVendor[0].supplier_name})`
        };
      }
      
      // Step 3: Item not found at all
      return {
        found: false,
        exactMatch: false,
        oldPrice: null,
        remarks: 'New Item - No pricing history available'
      };
      
    } catch (error) {
      return {
        found: false,
        oldPrice: null,
        error: error.message,
        remarks: `Error: ${error.message}`
      };
    }
  }

  /**
   * Get PORV quantity for item-vendor combination
   */
  async getPorvQuantity(itemCode, vendorId) {
    try {
      const itemVendorKey = `${itemCode}-${vendorId}`;
      
      const { data, error } = await this.supabase
        .from('porv_data')
        .select('qty_in_unit_of_entry')
        .eq('item_vendor_key', itemVendorKey)
        .single();
      
      if (error) {
        // No data found is not an error for PORV - could be new item
        if (error.code === 'PGRST116') {
          return {
            found: false,
            porv: 0,
            warning: `No PORV data found for Item: ${itemCode}, Vendor: ${vendorId}. Using 0.`
          };
        }
        throw error;
      }
      
      return {
        found: true,
        porv: parseFloat(data.qty_in_unit_of_entry) || 0
      };
      
    } catch (error) {
      return {
        found: false,
        porv: 0,
        error: error.message
      };
    }
  }

  /**
   * Calculate all fields for a single item
   */
  async calculateItem(item) {
    const {
      itemCode,
      itemDescription,
      vendorCode,
      vendorName,
      newPrice
    } = item;
    
    // Validate inputs
    if (!itemCode || !vendorCode || newPrice === undefined || newPrice === null) {
      return {
        success: false,
        error: 'Missing required fields: itemCode, vendorCode, newPrice'
      };
    }
    
    const result = {
      itemCode,
      itemDescription,
      vendorCode,
      vendorName,
      newPrice: parseFloat(newPrice),
      oldPrice: null,
      priceDiff: null,
      percentDiff: null,
      porv: null,
      impact: null,
      remarks: '',
      errors: [],
      warnings: []
    };
    
    // Get old price (with fallback logic)
    const oldPriceResult = await this.getOldPrice(itemCode, vendorCode);
    if (oldPriceResult.found) {
      result.oldPrice = oldPriceResult.oldPrice;
      
      // Add remarks if price from different vendor or new item
      if (oldPriceResult.remarks) {
        result.remarks = oldPriceResult.remarks;
        if (!oldPriceResult.exactMatch) {
          result.warnings.push(oldPriceResult.remarks);
        }
      }
      
      // Use description from DB if not provided
      if (!result.itemDescription && oldPriceResult.materialDescription) {
        result.itemDescription = oldPriceResult.materialDescription;
      }
      if (!result.vendorName && oldPriceResult.supplierName) {
        result.vendorName = oldPriceResult.supplierName;
      }
    } else {
      // New item or error
      result.remarks = oldPriceResult.remarks || 'New Item';
      if (oldPriceResult.error) {
        result.errors.push(oldPriceResult.error);
      } else {
        result.warnings.push(oldPriceResult.remarks);
      }
    }
    
    // Get PORV
    const porvResult = await this.getPorvQuantity(itemCode, vendorCode);
    if (porvResult.found) {
      result.porv = porvResult.porv;
    } else {
      if (porvResult.warning) {
        result.warnings.push(porvResult.warning);
      }
      if (porvResult.error) {
        result.errors.push(porvResult.error);
      }
      result.porv = 0; // Default to 0 if no PORV found
    }
    
    // Calculate derived fields if we have old price
    if (result.oldPrice !== null) {
      result.priceDiff = result.oldPrice - result.newPrice;
      
      if (result.oldPrice !== 0) {
        result.percentDiff = (result.priceDiff / result.oldPrice) * 100;
      } else {
        result.percentDiff = 0;
        result.warnings.push('Old price is 0, cannot calculate % difference');
      }
      
      result.impact = result.porv * result.priceDiff;
    }
    
    result.success = result.errors.length === 0;
    
    return result;
  }

  /**
   * Calculate all fields for multiple items
   */
  async calculateItems(items) {
    const results = [];
    
    for (const item of items) {
      const calculated = await this.calculateItem(item);
      results.push(calculated);
    }
    
    // Calculate totals
    const totalImpact = results
      .filter(r => r.impact !== null)
      .reduce((sum, r) => sum + r.impact, 0);
    
    const hasErrors = results.some(r => r.errors.length > 0);
    const hasWarnings = results.some(r => r.warnings.length > 0);
    
    return {
      items: results,
      summary: {
        totalItems: results.length,
        successfulCalculations: results.filter(r => r.success).length,
        failedCalculations: results.filter(r => !r.success).length,
        totalImpact,
        hasErrors,
        hasWarnings
      }
    };
  }

  /**
   * Get next form number
   */
  async getNextFormNumber() {
    try {
      const today = new Date();
      const yymmdd = today.toISOString()
        .slice(2, 10)
        .replace(/-/g, '');
      
      // Find highest sequence for today
      const { data, error } = await this.supabase
        .from('forms')
        .select('auto_form_no')
        .like('auto_form_no', `${yymmdd}_%`)
        .order('auto_form_no', { ascending: false })
        .limit(1);
      
      if (error) throw error;
      
      let nextSequence = 1;
      
      if (data && data.length > 0) {
        const lastFormNo = data[0].auto_form_no;
        const lastSequence = parseInt(lastFormNo.split('_')[1]);
        nextSequence = lastSequence + 1;
      }
      
      const formNumber = `${yymmdd}_${String(nextSequence).padStart(3, '0')}`;
      
      return {
        success: true,
        formNumber,
        date: yymmdd
      };
      
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Format currency for display
   */
  formatCurrency(amount) {
    if (amount === null || amount === undefined) return 'N/A';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      minimumFractionDigits: 2
    }).format(amount);
  }

  /**
   * Format percentage for display
   */
  formatPercentage(percent) {
    if (percent === null || percent === undefined) return 'N/A';
    return `${percent.toFixed(2)}%`;
  }

  /**
   * Get impact indicator (positive/negative/neutral)
   */
  getImpactIndicator(impact) {
    if (impact === null) return 'unknown';
    if (impact > 0) return 'savings';
    if (impact < 0) return 'increase';
    return 'neutral';
  }
}

module.exports = CalculationService;
