import https from 'https';
import http from 'http';
import logger from '../logger';

/**
 * Result from NIP/VAT lookup
 */
export interface CompanyLookupResult {
  valid: boolean;
  nip?: string;
  vatId?: string;
  name?: string;
  address?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  countryCode?: string;
  regon?: string;
  krs?: string;
  statusVat?: string;
  isActiveVat?: boolean;
  error?: string;
}

/**
 * Biała Lista VAT API response
 */
interface BialaListaResponse {
  result: {
    subject?: {
      name: string;
      nip: string;
      regon?: string;
      krs?: string;
      residenceAddress?: string;
      workingAddress?: string;
      statusVat?: string;
      accountNumbers?: string[];
    };
    requestId: string;
  };
}

/**
 * VIES SOAP response parsed
 */
interface ViesResult {
  valid: boolean;
  countryCode: string;
  vatNumber: string;
  name?: string;
  address?: string;
}

/**
 * NIP Lookup Service
 * Supports Polish NIP (via Biała Lista VAT) and EU VAT (via VIES)
 */
export class NipLookupService {
  private readonly bialaListaUrl = 'https://wl-api.mf.gov.pl/api/search/nip';
  private readonly viesUrl = 'https://ec.europa.eu/taxation_customs/vies/services/checkVatService';

  /**
   * Lookup Polish NIP via Biała Lista VAT API (Ministry of Finance)
   * Free, no registration required
   */
  async lookupPolishNip(nip: string): Promise<CompanyLookupResult> {
    try {
      // Clean NIP - remove non-digits
      const cleanNip = nip.replace(/[^0-9]/g, '');

      if (cleanNip.length !== 10) {
        return { valid: false, error: 'NIP musi mieć 10 cyfr' };
      }

      // Validate NIP checksum
      if (!this.validateNipChecksum(cleanNip)) {
        return { valid: false, error: 'Nieprawidłowa suma kontrolna NIP' };
      }

      // Get current date for API
      const today = new Date().toISOString().split('T')[0];
      const url = `${this.bialaListaUrl}/${cleanNip}?date=${today}`;

      logger.info(`[NipLookup] Looking up Polish NIP: ${cleanNip}`);

      const response = await this.httpGet<BialaListaResponse>(url);

      if (!response.result?.subject) {
        return { valid: false, error: 'Nie znaleziono podmiotu w Białej Liście VAT' };
      }

      const subject = response.result.subject;
      const address = subject.workingAddress || subject.residenceAddress || '';
      const parsedAddress = this.parsePolishAddress(address);

      return {
        valid: true,
        nip: subject.nip,
        name: subject.name,
        address: address,
        street: parsedAddress.street,
        city: parsedAddress.city,
        postalCode: parsedAddress.postalCode,
        country: 'Polska',
        countryCode: 'PL',
        regon: subject.regon,
        krs: subject.krs,
        statusVat: subject.statusVat,
        isActiveVat: subject.statusVat === 'Czynny',
      };
    } catch (error: any) {
      logger.error(`[NipLookup] Polish NIP lookup failed:`, error);
      return { valid: false, error: error.message || 'Błąd podczas wyszukiwania NIP' };
    }
  }

  /**
   * Lookup EU VAT number via VIES (VAT Information Exchange System)
   * Free, no registration required
   */
  async lookupEuVat(vatId: string): Promise<CompanyLookupResult> {
    try {
      // Clean and parse VAT ID
      const cleanVat = vatId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

      if (cleanVat.length < 4) {
        return { valid: false, error: 'Nieprawidłowy numer VAT UE' };
      }

      // Extract country code (first 2 letters)
      const countryCode = cleanVat.substring(0, 2);
      const vatNumber = cleanVat.substring(2);

      // Validate country code
      const euCountries = [
        'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES',
        'FI', 'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT',
        'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI' // XI = Northern Ireland
      ];

      if (!euCountries.includes(countryCode)) {
        return { valid: false, error: `Nieobsługiwany kod kraju: ${countryCode}` };
      }

      // For Polish VAT, use Biała Lista instead (more detailed)
      if (countryCode === 'PL') {
        return this.lookupPolishNip(vatNumber);
      }

      logger.info(`[NipLookup] Looking up EU VAT: ${countryCode}${vatNumber}`);

      const result = await this.callVies(countryCode, vatNumber);

      if (!result.valid) {
        return { valid: false, error: 'Numer VAT nie jest zarejestrowany w VIES' };
      }

      const parsedAddress = this.parseEuAddress(result.address || '', countryCode);

      return {
        valid: true,
        vatId: `${countryCode}${vatNumber}`,
        name: result.name,
        address: result.address,
        street: parsedAddress.street,
        city: parsedAddress.city,
        postalCode: parsedAddress.postalCode,
        country: this.getCountryName(countryCode),
        countryCode: countryCode,
        isActiveVat: true,
      };
    } catch (error: any) {
      logger.error(`[NipLookup] EU VAT lookup failed:`, error);
      return { valid: false, error: error.message || 'Błąd podczas wyszukiwania VAT UE' };
    }
  }

  /**
   * Auto-detect and lookup NIP or VAT
   */
  async lookup(identifier: string): Promise<CompanyLookupResult> {
    const clean = identifier.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

    // Check if it starts with letters (EU VAT)
    if (/^[A-Z]{2}/.test(clean)) {
      return this.lookupEuVat(clean);
    }

    // Otherwise assume Polish NIP
    return this.lookupPolishNip(clean);
  }

  /**
   * Validate Polish NIP checksum
   */
  private validateNipChecksum(nip: string): boolean {
    if (nip.length !== 10) return false;

    const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
    let sum = 0;

    for (let i = 0; i < 9; i++) {
      sum += parseInt(nip[i], 10) * weights[i];
    }

    const checksum = sum % 11;
    const lastDigit = parseInt(nip[9], 10);

    return checksum === lastDigit;
  }

  /**
   * Parse Polish address format
   * Example: "ul. Przykładowa 1/2, 00-001 Warszawa"
   */
  private parsePolishAddress(address: string): { street: string; city: string; postalCode: string } {
    const result = { street: '', city: '', postalCode: '' };

    if (!address) return result;

    // Try to extract postal code (XX-XXX format)
    const postalMatch = address.match(/(\d{2}-\d{3})/);
    if (postalMatch) {
      result.postalCode = postalMatch[1];
    }

    // Split by comma
    const parts = address.split(',').map(p => p.trim());

    if (parts.length >= 2) {
      result.street = parts[0];
      // City is usually after postal code
      const cityPart = parts[parts.length - 1];
      const cityMatch = cityPart.match(/\d{2}-\d{3}\s+(.+)/);
      if (cityMatch) {
        result.city = cityMatch[1];
      } else {
        result.city = cityPart.replace(/\d{2}-\d{3}/, '').trim();
      }
    } else {
      // Single line - try to parse
      const match = address.match(/^(.+?),?\s*(\d{2}-\d{3})\s+(.+)$/);
      if (match) {
        result.street = match[1];
        result.postalCode = match[2];
        result.city = match[3];
      } else {
        result.street = address;
      }
    }

    return result;
  }

  /**
   * Parse EU address (varies by country)
   */
  private parseEuAddress(address: string, countryCode: string): { street: string; city: string; postalCode: string } {
    const result = { street: '', city: '', postalCode: '' };

    if (!address) return result;

    // Generic parsing - postal codes vary by country
    const lines = address.split('\n').map(l => l.trim()).filter(l => l);

    if (lines.length >= 2) {
      result.street = lines[0];
      const lastLine = lines[lines.length - 1];

      // Try to extract postal code (common formats)
      const postalMatch = lastLine.match(/([A-Z0-9]{2,10}[-\s]?[A-Z0-9]{0,5})\s+(.+)/i);
      if (postalMatch) {
        result.postalCode = postalMatch[1];
        result.city = postalMatch[2];
      } else {
        result.city = lastLine;
      }
    } else {
      result.street = address;
    }

    return result;
  }

  /**
   * Get country name from code
   */
  private getCountryName(code: string): string {
    const countries: Record<string, string> = {
      'AT': 'Austria',
      'BE': 'Belgia',
      'BG': 'Bułgaria',
      'CY': 'Cypr',
      'CZ': 'Czechy',
      'DE': 'Niemcy',
      'DK': 'Dania',
      'EE': 'Estonia',
      'EL': 'Grecja',
      'ES': 'Hiszpania',
      'FI': 'Finlandia',
      'FR': 'Francja',
      'HR': 'Chorwacja',
      'HU': 'Węgry',
      'IE': 'Irlandia',
      'IT': 'Włochy',
      'LT': 'Litwa',
      'LU': 'Luksemburg',
      'LV': 'Łotwa',
      'MT': 'Malta',
      'NL': 'Holandia',
      'PL': 'Polska',
      'PT': 'Portugalia',
      'RO': 'Rumunia',
      'SE': 'Szwecja',
      'SI': 'Słowenia',
      'SK': 'Słowacja',
      'XI': 'Irlandia Północna',
    };
    return countries[code] || code;
  }

  /**
   * Call VIES SOAP service
   */
  private async callVies(countryCode: string, vatNumber: string): Promise<ViesResult> {
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
   <soapenv:Header/>
   <soapenv:Body>
      <urn:checkVat>
         <urn:countryCode>${countryCode}</urn:countryCode>
         <urn:vatNumber>${vatNumber}</urn:vatNumber>
      </urn:checkVat>
   </soapenv:Body>
</soapenv:Envelope>`;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'ec.europa.eu',
        port: 443,
        path: '/taxation_customs/vies/services/checkVatService',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml;charset=UTF-8',
          'Content-Length': Buffer.byteLength(soapEnvelope),
          'SOAPAction': '',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            // Parse SOAP response
            const validMatch = data.match(/<valid>(\w+)<\/valid>/i);
            const nameMatch = data.match(/<name>([^<]*)<\/name>/i);
            const addressMatch = data.match(/<address>([^<]*)<\/address>/i);

            const valid = validMatch ? validMatch[1].toLowerCase() === 'true' : false;
            const name = nameMatch ? this.decodeXmlEntities(nameMatch[1]) : undefined;
            const address = addressMatch ? this.decodeXmlEntities(addressMatch[1]) : undefined;

            resolve({
              valid,
              countryCode,
              vatNumber,
              name,
              address,
            });
          } catch (err) {
            reject(new Error('Błąd parsowania odpowiedzi VIES'));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Błąd połączenia z VIES: ${err.message}`));
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout połączenia z VIES'));
      });

      req.write(soapEnvelope);
      req.end();
    });
  }

  /**
   * HTTP GET helper
   */
  private httpGet<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      protocol.get(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'ZiraAI-PrintAgent/1.0',
        },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              resolve(JSON.parse(data));
            } else if (res.statusCode === 400) {
              // Bad request - usually invalid NIP
              const errorData = JSON.parse(data);
              reject(new Error(errorData.message || 'Nieprawidłowy NIP'));
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            }
          } catch (err) {
            reject(new Error('Błąd parsowania odpowiedzi'));
          }
        });
      }).on('error', (err) => {
        reject(new Error(`Błąd połączenia: ${err.message}`));
      });
    });
  }

  /**
   * Decode XML entities
   */
  private decodeXmlEntities(str: string): string {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }
}

// Singleton instance
export const nipLookupService = new NipLookupService();
