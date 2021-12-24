/* util.js - art of ezmqtt -- An MQTT interface for Ezlo hubs
Copyright (C) 2021, Patrick H. Rigney, All Rights Reserved

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const version = 21357;

/**
 * Deep compare two values. This handles primitives, arrays and objects. They are considered "equal"
 * if their types are the same and their values are the same. For objects to be "equal" they must
 * contain identical keys and values (recursively, if needed). For array, they must be equal in length
 * and have equal values in the same order (recursively, if needed).
 *
 * @param {any} e1 - First value to compare
 * @param {any} e2 - Second value to compare
 * @return {boolean} - True if arguments are equal as defined above; false otherwise.
 */
function deepCompare( e1, e2 ) {
    function compareArrays( a, b ) {
        let n = a.length;
        if ( ! Array.isArray( b ) || n !== b.length ) {
            return false;
        }
        for ( let k=0; k<n; ++k ) {
            if ( typeof a[k] !== typeof b[k] ) {
                return false;
            }
            if ( Array.isArray( a[k] ) ) {
                if ( ! compareArrays( a[k], b[k] ) ) {
                    return false;
                }
            } else if ( null !== a[k] && "object" === typeof a[k] ) {
                if ( ! compareObjects( a[k], b[k] ) ) {
                    return false;
                }
            } else if ( a[k] !== b[k] ) {  /* type-constrained naturally */
                return false;
            }
        }
        return true;
    }

    function compareObjects( a, b ) {
        let ak = Object.keys( a ).sort();
        if ( null === b || "object" !== typeof( b ) || ! compareArrays( ak, Object.keys( b ).sort() ) ) {
            return false;
        }
        let n = ak.length;
        for ( let k=0; k<n; ++k ) {
            let key = ak[ k ];
            if ( Array.isArray( a[key] ) ) {
                if ( ! compareArrays( a[key], b[key] ) ) {
                    return false;
                }
            } else if ( null === a[key] ) {
                if ( null !== b[key] ) {
                    return false;
                }
            } else if ( "object" === typeof a[key] ) {
                if ( ! compareObjects( a[key], b[key] ) ) {
                    return false;
                }
            } else if ( a[key] !== b[key] ) {  /* type-constrained naturally */
                return false;
            }
        }
        return true;
    }

    if ( Array.isArray( e1 ) ) {
        return compareArrays( e1, e2 );
    } else if ( null !== e1 && "object" === typeof e1 ) {
        return compareObjects( e1, e2 );
    }
    return e1 === e2;
}

var runInSequence = async function( implementationArray ) {
    // console.log("Starting sequence of", implementationArray.length, " Promises...");
    return new Promise( ( wrapper_resolve, wrapper_reject ) => {
        let index = 0;
        var next_impl = function( val ) {
            if ( index >= implementationArray.length ) {
                wrapper_resolve( val );
                return;
            }

            // console.log("Starting Promise", index, " of ", implementationArray.length);
            let impl = implementationArray[ index ];
            try {
                impl( function( result ) {
                        /* resolve */
                        // console.log("Promise", index," resolved");
                        ++index;
                        next_impl( result );
                    }, function( err ) {
                        /* reject */
                        // console.log("Promise sequence BROKEN",index,err);
                        wrapper_reject( err );
                    });
            } catch( err ) {
                if ( err instanceof Error ) {
                    err.index = index;
                }
                wrapper_reject( err );
            }
        };
        next_impl();
    });
};

module.exports = {
	deepCompare: deepCompare,
    runInSequence: runInSequence
};

